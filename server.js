const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// List of registered GharGarage Technicians
const TECHNICIANS = [
  {
    id: 1,
    name: 'Sunil',
    phone: '8712223439', // Replace with your real test phone number
    vehicleSpecialty: 'Car & Bike',
    isAvailable: true
  },
  {
    id: 2,
    name: 'Ganesh',
    phone: '7780736939', // Second technician number
    vehicleSpecialty: 'Car',
    isAvailable: true
  }
];

// Helper to check if an incoming WhatsApp number is a technician
function getTechnicianByPhone(phoneNumber) {
  return TECHNICIANS.find((tech) => tech.phone === phoneNumber);
}

// ==========================================
// CONFIGURATION & CREDENTIALS
// ==========================================
// 1. Secret token you invented for Meta Webhook verification
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'GharGarage_Secret_777';

// 2. Meta Permanent Access Token (starts with EAAB...)
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// 3. Phone Number ID from WhatsApp -> API Setup tab
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// In-memory store for active sessions (Replace with Supabase/DB for production)
const userSessions = {};

// ==========================================
// HELPER FUNCTIONS TO SEND WHATSAPP MESSAGES
// ==========================================

// Send plain text message
async function sendTextMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error) {
    console.error('Error sending text:', error.response?.data || error.message);
  }
}

// Send interactive button message (up to 3 buttons)
async function sendButtons(to, text, buttons) {
  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: text },
          action: {
            buttons: buttons.map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.title },
            })),
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error) {
    console.error('Error sending buttons:', error.response?.data || error.message);
  }
}

async function getWhatsAppMediaUrl(mediaId) {
  try {
    // 1. Ask Meta for the direct image download link
    const res = await axios.get(
      `https://graph.facebook.com/v20.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    const downloadUrl = res.data.url;

    // 2. Download the binary image buffer using your token
    const imageResponse = await axios.get(downloadUrl, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      responseType: 'arraybuffer'
    });

    console.log(`Successfully received image for media ID: ${mediaId}`);
    return downloadUrl; // Or upload this buffer to Supabase / AWS S3
  } catch (error) {
    console.error('Error fetching media:', error.response?.data || error.message);
  }
}

// Step A: Send Job Alert to Technician
async function alertTechniciansAboutJob(customerPhone, vehicleType, locationText) {
  const jobText = 
`🚨 *NEW GHARGARAGE JOB ALERT!*
--------------------------------
*Vehicle:* ${vehicleType}
*Service:* Doorstep Inspection & Repair
*Customer Contact:* ${customerPhone}
*Address:* ${locationText}
--------------------------------
Would you like to accept this job?`;

  // Send to Technician Rahul (Replace with your registered technician's phone number)
  const technicianPhone = '919876543210'; 

  console.log(`Sending job alert to technician at: ${technicianPhone}`);

  await sendButtons(technicianPhone, jobText, [
    { id: `TECH_ACCEPT_${customerPhone}`, title: '✅ Accept Job' },
    { id: `TECH_DECLINE_${customerPhone}`, title: '❌ Decline Job' }
  ]);
}

async function sendEstimationSlip(customerPhone, bookingId, partsList, totalAmount) {
  const slipText = 
`📋 *GHARGARAGE ESTIMATION SLIP*
*Job ID:* #${bookingId}
----------------------------------
*Required Parts & Labor:*
${partsList}
----------------------------------
*Estimated Total:* ₹${totalAmount}
*(Inclusive of doorstep labor & taxes)*

Please review and confirm to proceed with repairs:`;

  await sendButtons(customerPhone, slipText, [
    { id: `APPROVE_${bookingId}`, title: '✅ Approve Repair' },
    { id: `DECLINE_${bookingId}`, title: '❌ Decline' }
  ]);
}

const QRCode = require('qrcode');

// Helper to send image messages to WhatsApp
async function sendImageMessage(to, imageUrl, caption) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: to,
      type: 'image',
      image: {
        link: imageUrl,
        caption: caption
      }
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

// Generate UPI QR Code URL (using a free QR image endpoint or your own upload)
async function sendPaymentQRCode(customerPhone, bookingId, amount) {
  const upiId = 'yourbusiness@upi'; // Replace with your merchant UPI ID
  const payeeName = 'GharGarage';
  const upiString = `upi://pay?pa=${upiId}&pn=${payeeName}&am=${amount}&tn=Bill_${bookingId}`;

  // Generate public QR code image link
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(upiString)}`;

  await sendImageMessage(
    customerPhone,
    qrImageUrl,
    `💳 *GHARGARAGE PAYMENT INVOICE*\nTotal Payable: *₹${amount}*\n\nScan the QR code above using GPay, PhonePe, or Paytm to pay.`
  );
}

async function sendReviewRequest(customerPhone) {
  await sendButtons(
    customerPhone,
    '🚗✨ *Service Complete!* \nYour vehicle is ready and tuned. How was your GharGarage doorstep experience?',
    [
      { id: 'RATING_5', title: '⭐⭐⭐⭐⭐ Excellent' },
      { id: 'RATING_4', title: '⭐⭐⭐⭐ Good' },
      { id: 'RATING_3', title: '⭐⭐⭐ Average' }
    ]
  );
}


// ==========================================
// 1. GET /webhook (Meta Handshake Verification)
// ==========================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully by Meta!');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ==========================================
// 2. POST /webhook (THIS IS WHERE THE LOGIC LIVES)
// ==========================================
app.post('/webhook', async (req, res) => {
  // Acknowledge Meta immediately with 200 OK
  res.status(200).send('EVENT_RECEIVED');

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    // Ignore read receipts or status updates
    if (!message) return;

    const sender = message.from; // Customer WhatsApp Number
    const msgType = message.type;

    if (!userSessions[sender]) {
      userSessions[sender] = { state: 'IDLE', vehicle: null };
    }

    const session = userSessions[sender];

    // CASE A: User sends "HI" or greeting text
    if (msgType === 'text') {
      const userText = message.text.body.trim().toLowerCase();

      if (userText === 'hi' || userText === 'hello' || session.state === 'IDLE') {
        session.state = 'SELECTING_VEHICLE';

        await sendButtons(
          sender,
          'Welcome to GharGarage! 🚗🏍️\n"Your Garage, At Your Doorstep."\n\nPlease select your vehicle type to begin:',
          [
            { id: 'SELECT_BIKE', title: '🏍️ Bike' },
            { id: 'SELECT_CAR', title: '🚗 Car' },
          ]
        );
        return;
      }
    }

    // CASE B: User clicks on an interactive button
    if (msgType === 'interactive' && message.interactive.type === 'button_reply') {
      const buttonId = message.interactive.button_reply.id;

      // 1. Vehicle Selection
      if (buttonId === 'SELECT_BIKE' || buttonId === 'SELECT_CAR') {
        session.vehicle = buttonId === 'SELECT_BIKE' ? 'Bike' : 'Car';
        session.state = 'SELECTING_SERVICE';

        await sendButtons(
          sender,
          `You selected: ${session.vehicle} ✅\nWhat service would you like today?`,
          [
            { id: 'SERVICE_WASH', title: '🧼 Doorstep Wash' },
            { id: 'SERVICE_REPAIR', title: '🔧 Service / Repair' },
          ]
        );
        return;
      }

      // 2. Wash Selected -> Show Rate Card & Accept/Decline Buttons
      if (buttonId === 'SERVICE_WASH') {
        session.state = 'WASH_DECISION';
        const price = session.vehicle === 'Car' ? '₹399' : '₹199';

        await sendButtons(
          sender,
          `Doorstep Foam Wash for ${session.vehicle}:\n💰 Rate: ${price} (Includes exterior wash & interior clean).\n\nWould you like to confirm this booking?`,
          [
            { id: 'WASH_ACCEPT', title: '✅ Accept' },
            { id: 'WASH_DECLINE', title: '❌ Decline' },
          ]
        );
        return;
      }

      // 3. Wash Accepted
      if (buttonId === 'WASH_ACCEPT') {
        session.state = 'WASH_CONFIRMED';
        await sendTextMessage(
          sender,
          'Awesome! Your wash booking is confirmed. 🧼\nPlease send your live location or address so our washer can reach you.'
        );
        return;
      }

      // 4. Wash Declined
      if (buttonId === 'WASH_DECLINE') {
        session.state = 'IDLE';
        await sendTextMessage(
          sender,
          'No problem! May we know why? (e.g. price high, changed mind). Type your feedback below.'
        );
        return;
      }

      // 5. Service / Repair Selected
      if (buttonId === 'SERVICE_REPAIR') {
        session.state = 'SERVICE_LOCATION';
        await sendTextMessage(
          sender,
          `Got it! For ${session.vehicle} Service & Repair, our certified technician will visit your location for inspection.\n\nPlease share your live location or street address:`
        );
        return;
      }
    }
  } catch (error) {
    console.error('Error processing webhook event:', error);
  }

  // When Customer sends their address/location text
if (msgType === 'text' && session.state === 'SERVICE_LOCATION') {
  const customerAddress = message.text.body;
  session.state = 'DISPATCHED';

  // 1. Confirm to Customer
  await sendTextMessage(sender, 'Thank you! Finding and alerting the nearest certified technician now... 🔍');

  // 2. Alert the Technician!
  await alertTechniciansAboutJob(sender, session.vehicle, customerAddress);
  return;
}
});



// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GharGarage Server is running on port ${PORT}`);
});
