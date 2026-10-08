const axios = require('axios');

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Helper: Send Interactive Button Message
async function sendButtons(to, text, buttons) {
  return axios.post(
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
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

// Helper: Send WhatsApp Text Message
async function sendTextMessage(to, text) {
  return axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: text },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

app.post('/webhook', async (req, res) => {
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const message = changes?.value?.messages?.[0];

  if (!message) return res.sendStatus(200);

  const sender = message.from; // Phone number of sender
  const msgType = message.type;

  // 1. Check if sender is a TECHNICIAN
  const technician = await getTechnicianByPhone(sender);
  if (technician) {
    return handleTechnicianFlow(technician, message);
  }

  // 2. Otherwise, treat as CUSTOMER
  const activeBooking = await getActiveBooking(sender);

  // A. Customer sends initial "HI"
  if (msgType === 'text' && message.text.body.trim().toLowerCase() === 'hi') {
    await sendButtons(
      sender,
      'Welcome to GharGarage! 🚗🏍️\n"Your Garage, At Your Doorstep."\n\nPlease select your vehicle type:',
      [
        { id: 'SELECT_BIKE', title: '🏍️ Bike' },
        { id: 'SELECT_CAR', title: '🚗 Car' },
      ]
    );
    await updateBookingState(sender, { status: 'SELECTING_VEHICLE' });
    return res.sendStatus(200);
  }

  // B. Customer clicks interactive buttons
  if (msgType === 'interactive' && message.interactive.type === 'button_reply') {
    const buttonId = message.interactive.button_reply.id;

    if (buttonId === 'SELECT_BIKE' || buttonId === 'SELECT_CAR') {
      const vType = buttonId === 'SELECT_BIKE' ? 'BIKE' : 'CAR';
      await updateBookingState(sender, { vehicle_type: vType, status: 'SELECTING_SERVICE' });

      await sendButtons(
        sender,
        `Selected: ${vType}.\nWhat service would you like today?`,
        [
          { id: 'SERVICE_WASH', title: '🧼 Doorstep Wash' },
          { id: 'SERVICE_REPAIR', title: '🔧 Service / Repair' },
        ]
      );
      return res.sendStatus(200);
    }

    // C. Wash Flow: Show rates and Accept / Decline
    if (buttonId === 'SERVICE_WASH') {
      const rate = activeBooking.vehicle_type === 'CAR' ? '₹399' : '₹199';
      await sendButtons(
        sender,
        `Doorstep Foam Wash & Vacuuming for ${activeBooking.vehicle_type}:\nRate: ${rate}\n\nWould you like to confirm?`,
        [
          { id: 'WASH_ACCEPT', title: '✅ Accept & Book' },
          { id: 'WASH_DECLINE', title: '❌ Decline' },
        ]
      );
      return res.sendStatus(200);
    }

    // D. Service Flow: Dispatch Alert to Technician & Admin
    if (buttonId === 'SERVICE_REPAIR') {
      await sendTextMessage(sender, 'Please share your live location or street address to assign the nearest technician:');
      await updateBookingState(sender, { service_type: 'SERVICE', status: 'AWAITING_LOCATION' });
      return res.sendStatus(200);
    }
  }

  res.sendStatus(200);
});
