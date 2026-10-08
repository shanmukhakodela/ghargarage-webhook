const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

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
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GharGarage Server is running on port ${PORT}`);
});
