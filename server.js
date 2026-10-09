const express = require('express');
const axios = require('axios');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

// ==========================================
// CONFIGURATION & CREDENTIALS
// ==========================================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'GharGarage_Secret_777';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Admin WhatsApp Phone Number (Digits only with country code, e.g., 919876543210)
const ADMIN_PHONE = (process.env.ADMIN_PHONE || '919876543210').replace(/\D/g, '');

// Registered GharGarage Technicians
const TECHNICIANS = [
  {
    id: 1,
    name: 'Sunil',
    phone: '+91 8712223439',
    vehicleSpecialty: 'Car & Bike',
    isAvailable: true,
  },
  {
    id: 2,
    name: 'Ganesh',
    phone: '+91 7780736939',
    vehicleSpecialty: 'Car',
    isAvailable: true,
  },
];

// In-memory session store (Use Redis / Supabase in production)
const userSessions = {};

// Helper: Normalize phone numbers to digits only for WhatsApp Cloud API
function sanitizePhone(phone) {
  return phone ? phone.replace(/\D/g, '') : '';
}

// Helper: Find technician by incoming phone number
function getTechnicianByPhone(phoneNumber) {
  const cleanIncoming = sanitizePhone(phoneNumber);
  return TECHNICIANS.find((tech) => sanitizePhone(tech.phone) === cleanIncoming);
}

// Helper: Fetch available technicians matching vehicle type
function getAvailableTechniciansForVehicle(vehicleType) {
  return TECHNICIANS.filter((tech) => {
    if (!tech.isAvailable) return false;
    if (tech.vehicleSpecialty === 'Car & Bike') return true;
    return tech.vehicleSpecialty.toLowerCase() === vehicleType.toLowerCase();
  });
}

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
        to: sanitizePhone(to),
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
    console.error(`Error sending text to ${to}:`, error.response?.data || error.message);
  }
}

// Send interactive button message (up to 3 buttons)
async function sendButtons(to, text, buttons) {
  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: sanitizePhone(to),
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
    console.error(`Error sending buttons to ${to}:`, error.response?.data || error.message);
  }
}

// Send image message
async function sendImageMessage(to, imageUrl, caption) {
  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: sanitizePhone(to),
        type: 'image',
        image: {
          link: imageUrl,
          caption: caption,
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
    console.error(`Error sending image to ${to}:`, error.response?.data || error.message);
  }
}

// ==========================================
// NOTIFICATION DISPATCHERS
// ==========================================

// 1. Notify Admin about new job & dispatched technicians
async function notifyAdminAboutJob(customerPhone, serviceType, vehicleType, locationText, alertedTechNames) {
  const adminMessage =
`🔔 *ADMIN ALERT: NEW BOOKING RECEIVED*
--------------------------------
*Customer:* +${customerPhone}
*Vehicle:* ${vehicleType}
*Service:* ${serviceType}
*Location:* ${locationText}
*Alerted Technicians:* ${alertedTechNames.length > 0 ? alertedTechNames.join(', ') : 'None available ⚠️'}
--------------------------------
Status: Awaiting technician acceptance.`;

  console.log(`Notifying Admin at ${ADMIN_PHONE}`);
  await sendTextMessage(ADMIN_PHONE, adminMessage);
}

// 2. Alert qualified technicians about the job
async function alertTechniciansAboutJob(customerPhone, serviceType, vehicleType, locationText) {
  const qualifiedTechs = getAvailableTechniciansForVehicle(vehicleType);

  if (qualifiedTechs.length === 0) {
    console.warn(`No available technicians found for ${vehicleType}`);
    // Notify Admin of no availability
    await sendTextMessage(
      ADMIN_PHONE,
      `⚠️ *NO TECHNICIANS AVAILABLE* for customer +${customerPhone} (${vehicleType} - ${serviceType}). Location: ${locationText}`
    );
    return [];
  }

  const jobText =
`🚨 *NEW GHARGARAGE JOB ALERT!*
--------------------------------
*Vehicle:* ${vehicleType}
*Service:* ${serviceType}
*Customer Contact:* +${customerPhone}
*Address/Location:* ${locationText}
--------------------------------
Would you like to accept this job?`;

  const alertedNames = [];

  for (const tech of qualifiedTechs) {
    console.log(`Dispatching job alert to ${tech.name} (${tech.phone})`);
    alertedNames.push(tech.name);

    await sendButtons(tech.phone, jobText, [
      { id: `TECH_ACCEPT_${customerPhone}`, title: '✅ Accept Job' },
      { id: `TECH_DECLINE_${customerPhone}`, title: '❌ Decline Job' },
    ]);
  }

  return alertedNames;
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
// 2. POST /webhook (Main Logic Flow)
// ==========================================
app.post('/webhook', async (req, res) => {
  // Acknowledge Meta immediately to prevent timeout retries
  res.status(200).send('EVENT_RECEIVED');

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    // Ignore read receipts or status updates
    if (!message) return;

    const sender = message.from;
    const msgType = message.type;

    // Check if message came from a registered technician
    const activeTechnician = getTechnicianByPhone(sender);

    // Initialize customer session if not already existing
    if (!userSessions[sender]) {
      userSessions[sender] = {
        state: 'IDLE',
        vehicle: null,
        service: null,
        location: null,
      };
    }
    const session = userSessions[sender];

    // ----------------------------------------------------
    // CASE 1: BUTTON REPLIES
    // ----------------------------------------------------
    if (msgType === 'interactive' && message.interactive.type === 'button_reply') {
      const buttonId = message.interactive.button_reply.id;

      // --- A. Technician Action: ACCEPT JOB ---
      if (buttonId.startsWith('TECH_ACCEPT_')) {
        const custPhone = buttonId.replace('TECH_ACCEPT_', '');
        const techName = activeTechnician ? activeTechnician.name : 'A certified technician';
        const techPhone = activeTechnician ? activeTechnician.phone : sender;

        // 1. Confirm with Technician
        await sendTextMessage(sender, `✅ You have accepted the job for customer +${custPhone}. Please contact them immediately.`);

        // 2. Notify Customer
        await sendTextMessage(
          custPhone,
          `🎉 Great news! Technician *${techName}* (${techPhone}) has accepted your booking and is heading your way.`
        );

        // 3. Notify Admin
        await sendTextMessage(
          ADMIN_PHONE,
          `✅ *JOB ACCEPTED*\nTechnician: ${techName} (${techPhone})\nCustomer: +${custPhone}`
        );
        return;
      }

      // --- B. Technician Action: DECLINE JOB ---
      if (buttonId.startsWith('TECH_DECLINE_')) {
        const custPhone = buttonId.replace('TECH_DECLINE_', '');
        const techName = activeTechnician ? activeTechnician.name : sender;

        await sendTextMessage(sender, 'You declined this job. It will remain open for other technicians.');

        // Notify Admin of decline
        await sendTextMessage(
          ADMIN_PHONE,
          `ℹ️ Technician ${techName} declined job for Customer +${custPhone}.`
        );
        return;
      }

      // --- C. Customer Action: Vehicle Selection ---
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

      // --- D. Customer Action: Wash Service Selected ---
      if (buttonId === 'SERVICE_WASH') {
        session.service = 'Doorstep Foam Wash';
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

      // --- E. Customer Action: Wash Accepted ---
      if (buttonId === 'WASH_ACCEPT') {
        session.state = 'AWAITING_LOCATION';
        await sendTextMessage(
          sender,
          'Awesome! Your wash booking is confirmed. 🧼\nPlease send your street address or share your live WhatsApp location pin:'
        );
        return;
      }

      // --- F. Customer Action: Wash Declined ---
      if (buttonId === 'WASH_DECLINE') {
        session.state = 'IDLE';
        await sendTextMessage(
          sender,
          'No problem! May we know why? (e.g. price high, changed mind). Type your feedback below.'
        );
        return;
      }

      // --- G. Customer Action: Service / Repair Selected ---
      if (buttonId === 'SERVICE_REPAIR') {
        session.service = 'Doorstep Inspection & Repair';
        session.state = 'AWAITING_LOCATION';

        await sendTextMessage(
          sender,
          `Got it! For ${session.vehicle} Service & Repair, our certified technician will visit your location for inspection.\n\nPlease share your street address or send your live WhatsApp location pin:`
        );
        return;
      }
    }

    // ----------------------------------------------------
    // CASE 2: LOCATION RECEIVED (TEXT OR NATIVE WHATSAPP PIN)
    // ----------------------------------------------------
    if (session.state === 'AWAITING_LOCATION' || session.state === 'SERVICE_LOCATION' || session.state === 'WASH_CONFIRMED') {
      let customerLocation = '';

      if (msgType === 'text') {
        customerLocation = message.text.body.trim();
      } else if (msgType === 'location') {
        const loc = message.location;
        const namePart = loc.name ? ` (${loc.name})` : '';
        const addressPart = loc.address ? `\nAddress: ${loc.address}` : '';
        customerLocation = `Lat: ${loc.latitude}, Long: ${loc.longitude}${namePart}${addressPart}\nMaps: https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
      }

      if (customerLocation) {
        session.location = customerLocation;
        session.state = 'DISPATCHED';

        // 1. Confirm with customer
        await sendTextMessage(
          sender,
          'Thank you! Finding and alerting the nearest certified technician now... 🔍'
        );

        // 2. Fetch & alert matched technicians
        const alertedNames = await alertTechniciansAboutJob(
          sender,
          session.service || 'Doorstep Service',
          session.vehicle,
          customerLoca
