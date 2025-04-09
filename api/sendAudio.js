import nodemailer from "nodemailer";
import crypto from "crypto";
import { Buffer } from 'buffer';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST requests allowed" });
  }

  try {
    const rawBodyBuffer = await getRawBody(req);
    const rawBody = rawBodyBuffer.toString('utf-8');
    
    const elevenlabsSignature = req.headers["elevenlabs-signature"];
    
    console.log("Headers received:", JSON.stringify(req.headers));
    
    if (!elevenlabsSignature) {
      return res.status(401).json({ error: "Missing ElevenLabs signature" });
    }

    console.log("Signature received:", elevenlabsSignature);
    console.log("Raw body:", rawBody);

    const signatureParts = elevenlabsSignature.split(',');
    const timestampPart = signatureParts.find(part => part.startsWith('t='));
    const signaturePart = signatureParts.find(part => part.startsWith('v0='));
    
    if (!timestampPart || !signaturePart) {
      console.log("Invalid signature format:", elevenlabsSignature);
      return res.status(401).json({ error: "Invalid signature format" });
    }
    
    const timestamp = timestampPart.substring(2);
    const signature = signaturePart.substring(3);  // Extract just the hash without "v0="

    const reqTimestamp = parseInt(timestamp) * 1000;
    const tolerance = Date.now() - 30 * 60 * 1000; 
    if (reqTimestamp < tolerance) {
      return res.status(403).json({ error: "Request expired" });
    }

    const message = `${timestamp}.${rawBody}`;
    console.log("Message to sign:", message);
    
    const digest = crypto.createHmac('sha256', process.env.WEBHOOK_SECRET)
      .update(message)
      .digest('hex');
    
    const expectedSignature = digest;
    console.log("Expected signature:", expectedSignature);
    console.log("Received signature:", signature);

    if (signature !== expectedSignature) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const payload = JSON.parse(rawBody);
    
    if (payload.type !== "post_call_transcription") {
      return res.status(400).json({ error: "Unsupported webhook event type" });
    }

    const conversationId = payload.data?.conversation_id;
    if (!conversationId) {
      return res.status(400).json({ error: "Missing conversation_id in payload" });
    }

    const transcriptSummary = payload.data?.analysis?.transcript_summary || "No summary available.";

    let transcriptText = "CONVERSATION TRANSCRIPT:\n\n";
    if (payload.data?.transcript && Array.isArray(payload.data.transcript)) {
      payload.data.transcript.forEach((turn, index) => {
        transcriptText += `${turn.role.toUpperCase()}: ${turn.message}\n\n`;
      });
    } else {
      transcriptText += "Transcript not available.\n";
    }

    const XI_API_KEY = process.env.ELEVENLABS_API_KEY;
    const audioUrl = `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}/audio`;

    const response = await fetch(audioUrl, {
      method: "GET",
      headers: {
        "xi-api-key": XI_API_KEY,
      },
    });

    if (!response.ok) {
      console.error("Failed to fetch audio:", await response.text());
      return res
        .status(200) 
        .json({ message: "Processed with errors", error: "Failed to fetch audio" });
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = process.env.SMTP_PORT;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const emailFrom = process.env.EMAIL_FROM;
    const emailTo = process.env.EMAIL_TO;
  
    if (
      !smtpHost ||
      !smtpPort ||
      !smtpUser ||
      !smtpPass ||
      !emailFrom ||
      !emailTo
    ) {
      console.error("Missing SMTP configuration:", { 
        hasHost: !!smtpHost, 
        hasPort: !!smtpPort, 
        hasUser: !!smtpUser,
        hasPass: !!smtpPass,
        hasFrom: !!emailFrom,
        hasTo: !!emailTo
      });
      return res
        .status(500)
        .json({ error: "Server configuration is incomplete" });
    }
  
    try {
      let transporter = nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(smtpPort, 10),
        secure: parseInt(smtpPort, 10) === 465, // Auto-determine based on port
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });
      
      // Verify SMTP connection configuration
      await new Promise((resolve, reject) => {
        transporter.verify(function(error, success) {
          if (error) {
            console.error("SMTP verification failed:", error);
            reject(error);
          } else {
            console.log("SMTP server is ready to take our messages");
            resolve(success);
          }
        });
      });

      const callDuration = payload.data?.metadata?.call_duration_secs || "N/A";
      
      const mailOptions = {
        from: emailFrom,
        to: emailTo,
        subject: `Rockstar AI Recent Interaction Recording - ${new Date().toLocaleString()}`,
        text: `Call Duration: ${callDuration} seconds\n` +
              `${transcriptText}`,
        attachments: [
          {
            filename: `conversation-${conversationId}.mp3`,
            content: audioBuffer,
          },
        ],
      };

      console.log("Attempting to send email...");
      const info = await transporter.sendMail(mailOptions);
      console.log("Email sent successfully:", info.response);

      return res.status(200).json({ message: "Webhook processed successfully" });
    } catch (emailError) {
      console.error("Email sending failed:", emailError);
      return res.status(200).json({ 
        message: "Processed with errors", 
        error: `Email error: ${emailError.message}` 
      });
    }
  } catch (error) {
    console.error("Error processing webhook:", error);
    return res.status(200).json({ message: "Processed with errors", error: error.message });
  }
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      resolve(buffer);
    });
    
    req.on('error', (err) => {
      reject(err);
    });
  });
}
