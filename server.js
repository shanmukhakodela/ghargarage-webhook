const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ==========================================
// CONFIGURATION & CREDENTIALS
// ==========================================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'GharGarage_Secret_777';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const MERCHANT_UPI_ID = process.env.MERCHANT_UPI_ID || 'ghargarage@upi';
const MERCHANT_NAME = 'GharGarage';

// Admin WhatsApp Phone Number (Digits only with country code)
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

// In-Memory Storage
const userSessions = {}; // Key: senderPhone -> session state
const bookings = {};     // Key: bookingId -> booking data

// ==========================================
// HELPER UTILITIES
// ==========================================

function sanitizePhone(phone) {
  return phone ? phone.replace(/\D/g, '') : '';
}

function getTechnicianByPhone(phoneNumber) {
  const cleanIncoming = sanitizePhone(phoneNumber);
  return TECHNICIANS.find((tech) => sanitizePhone(tech.phone) === cleanIncoming);
}

function getAvailableTechniciansForVehicle(vehicleType) {
  return TECHNICIANS.filter((tech) => {
    if (!tech.isAvailable) return false;
    if (tech.vehicleSpecialty === 'Car & Bike') return true;
    return tech.vehicleSpecialty.toLowerCase() === vehicleType.toLowerCase();
  });
}

function getActiveBookingForTechnician(techPhone) {
  const clean = sanitizePhone(techPhone);
  return Object.values(bookings).find(
    (b) => sanitizePhone(b.technicianPhone) === clean && b.status !== 'COMPLETED' && b.status !== 'CANCELLED'
  );
}

function parseEstimationText(text) {
  let parts = text;
  let amount = 0;

  if (text.includes('|')) {
    const split = text.split('|');
    parts = split[0].replace(/^estimate:\s*/i, '').trim();
    const amountStr = split[1].replace(/[^0-9.]/g, '');
    amount = parseFloat(amountStr) || 0;
  } else {
    const numbers = text.match(/\d+(\.\d+)?/g);
    if (numbers && numbers.length > 0) {
      amount = parseFloat(numbers[numbers.length - 1]);
      parts = text.replace(new RegExp(`${amount}\\s*$`), '').trim();
    }
  }

  return {
    partsList: parts || 'Doorstep Inspection & Maintenance',
    totalAmount: amount || 499,
  };
}

// ==========================================
// WHATSAPP API SENDERS
// ==========================================

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
              reply: { id: b.id, title: b.title.substring(0, 20) }, // 20 chars max for WhatsApp API
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
// BUSINESS WORKFLOW FUNCTIONS
// ==========================================

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
    { id: `DECLINE_${bookingId}`, title: '❌ Decline' },
  ]);

  await sendTextMessage(
    ADMIN_PHONE,
    `📋 *ESTIMATION SLIP SENT FOR #${bookingId}*\nCustomer: +${customerPhone}\nParts: ${partsList}\nTotal: ₹${totalAmount}`
  );
}

// Dispatches invoice, QR code, and actionable buttons to customer and technician
async function presentPostServiceActionItems(booking) {
  const bookingId = booking.id;
  const amount = booking.totalAmount;
  const upiString = `upi://pay?pa=${MERCHANT_UPI_ID}&pn=${encodeURIComponent(MERCHANT_NAME)}&am=${amount}&tn=Bill_${bookingId}`;
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(upiString)}`;

  // 1. Send Invoice & QR Code to Customer
  await sendImageMessage(
    booking.customerPhone,
    qrImageUrl,
    `🎉 *SERVICE COMPLETED!*\nJob ID: #${bookingId}\nTotal Bill: *₹${amount}*\n\nScan above using GPay, PhonePe, or Paytm to pay.`
  );

  // 2. Action Items for Customer
  await sendButtons(
    booking.customerPhone,
    `Please select your payment confirmation method:`,
    [
      { id: `PAID_ONLINE_${bookingId}`, title: '✅ Paid Online' },
      { id: `PAID_CASH_${bookingId}`, title: '💵 Paid Cash' },
    ]
  );

  // 3. Action Items for Technician
  await sendButtons(
    booking.technicianPhone,
    `✅ Post-service photos saved! Invoice of ₹${amount} sent to customer.\n\nPlease confirm when payment is collected:`,
    [
      { id: `TECH_CONFIRM_PAY_${bookingId}`, title: '✅ Payment Received' },
      { id: `TECH_CASH_PAY_${bookingId}`, title: '💵 Cash Collected' },
    ]
  );
}

async function sendReviewRequest(customerPhone, bookingId) {
  await sendButtons(
    customerPhone,
    '🚗✨ *Service Complete & Paid!* \nHow was your GharGarage doorstep service experience?',
    [
      { id: `RATE_5_${bookingId}`, title: '⭐ 5 Star - Great' },
      { id: `RATE_4_${bookingId}`, title: '⭐ 4 Star - Good' },
      { id: `RATE_3_${bookingId}`, title: '⭐ 3 Star - Okay' },
    ]
  );
}

// ==========================================
// 1. GET /webhook (Meta Verification)
// ==========================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ==========================================
// 2. POST /webhook (Main Controller)
// ==========================================
app.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message) return;

    const sender = message.from;
    const msgType = message.type;
    const activeTechnician = getTechnicianByPhone(sender);

    if (!userSessions[sender]) {
      userSessions[sender] = { state: 'IDLE', activeBookingId: null };
    }
    const session = userSessions[sender];

    // ====================================================
    // A. INTERACTIVE BUTTON REPLIES
    // ====================================================
    if (msgType === 'interactive' && message.interactive.type === 'button_reply') {
      const buttonId = message.interactive.button_reply.id;

      // --------------------------------------------------
      // STEP 1: TECHNICIAN ACCEPTS JOB (WITH LOCKING & NOTIFICATION)
      // --------------------------------------------------
      if (buttonId.startsWith('TECH_ACCEPT_')) {
        const bookingId = buttonId.replace('TECH_ACCEPT_', '');
        const booking = bookings[bookingId];

        if (!booking) {
          await sendTextMessage(sender, '⚠️ This job does not exist or has expired.');
          return;
        }

        const attemptingTechName = activeTechnician ? activeTechnician.name : 'Another Technician';
        const attemptingTechPhone = activeTechnician ? activeTechnician.phone : sender;

        // CHECK IF ALREADY ACCEPTED BY ANOTHER TECHNICIAN
        if (booking.technicianPhone && sanitizePhone(booking.technicianPhone) !== sanitizePhone(attemptingTechPhone)) {
          // 1. Notify the technician who is trying to accept now
          await sendTextMessage(
            sender,
            `⚠️ *JOB ALREADY ASSIGNED*\nJob #${bookingId} has already been accepted by technician *${booking.technicianName}*.\n\nYou will be notified for the next available job.`
          );

          // 2. Notify the technician who ALREADY accepted the job
          await sendTextMessage(
            booking.technicianPhone,
            `ℹ️ *Notice:* Technician *${attemptingTechName}* (+${attemptingTechPhone}) attempted to accept Job #${bookingId}.\n\nDon't worry, this job remains securely assigned to *YOU*. Please continue with the customer visit.`
          );

          // 3. Notify Admin
          await sendTextMessage(
            ADMIN_PHONE,
            `ℹ️ Tech ${attemptingTechName} tried to accept #${bookingId}, but it was already assigned to ${booking.technicianName}.`
          );
          return;
        }

        // FIRST TECHNICIAN TO ACCEPT
        booking.technicianPhone = attemptingTechPhone;
        booking.technicianName = attemptingTechName;
        booking.status = 'TECH_ACCEPTED';

        // 1. Alert Customer with ~30 mins ETA
        await sendTextMessage(
          booking.customerPhone,
          `🚗 Good news! Technician *${attemptingTechName}* (📞 ${attemptingTechPhone}) has accepted your booking.\n` +
          `⏱️ *Estimated Arrival Time: Around 30 minutes.*\n\n` +
          `The technician is on the way to your doorstep!`
        );

        // 2. Send technician confirmation & Arrival Button
        await sendButtons(
          sender,
          `✅ You accepted Booking #${bookingId}.\n📍 Customer Location: ${booking.location}\n📞 Contact: +${booking.customerPhone}\n\nWhen you reach the doorstep, tap below:`,
          [{ id: `TECH_ARRIVED_${bookingId}`, title: '📍 I Have Arrived' }]
        );

        // 3. Notify Admin
        await sendTextMessage(
          ADMIN_PHONE,
          `✅ *TECH ACCEPTED #${bookingId}*\nTech: ${attemptingTechName} (${attemptingTechPhone})\nETA: ~30 mins to Customer: +${booking.customerPhone}`
        );
        return;
      }

      // Decline Job
      if (buttonId.startsWith('TECH_DECLINE_')) {
        const bookingId = buttonId.replace('TECH_DECLINE_', '');
        await sendTextMessage(sender, 'Job declined. Remaining technicians will be alerted.');
        return;
      }

      // --------------------------------------------------
      // STEP 2: TECHNICIAN ARRIVAL CONFIRMATION
      // --------------------------------------------------
      if (buttonId.startsWith('TECH_ARRIVED_')) {
        const bookingId = buttonId.replace('TECH_ARRIVED_', '');
        const booking = bookings[bookingId];

        if (booking) {
          booking.status = 'AWAITING_PRE_PHOTOS';
          await sendTextMessage(
            sender,
            `📸 *Arrival Confirmed!*\n\nPlease upload the vehicle pre-inspection photo(s) (condition, damages, odometer) via WhatsApp camera/attachment:`
          );

          await sendTextMessage(
            booking.customerPhone,
            `📍 Technician *${booking.technicianName}* has arrived at your location and is starting vehicle inspection.`
          );
        }
        return;
      }

      // --------------------------------------------------
      // STEP 3: CUSTOMER APPROVES ESTIMATE
      // --------------------------------------------------
      if (buttonId.startsWith('APPROVE_')) {
        const bookingId = buttonId.replace('APPROVE_', '');
        const booking = bookings[bookingId];

        if (booking) {
          booking.status = 'IN_PROGRESS';

          await sendTextMessage(
            sender,
            `✅ You have approved the estimate of *₹${booking.totalAmount}*.\nTechnician is now proceeding with repair/service work!`
          );

          await sendTextMessage(
            booking.technicianPhone,
            `🎉 *ESTIMATE APPROVED!*\nCustomer approved the repair for #${bookingId}.\n\n` +
            `👉 Please proceed with the service. Once done, upload the post-service vehicle photo(s).`
          );

          await sendTextMessage(
            ADMIN_PHONE,
            `✅ Customer approved estimate for #${bookingId} (₹${booking.totalAmount}). Work in progress.`
          );
        }
        return;
      }

      // STEP 3 (ALT): CUSTOMER DECLINES ESTIMATE
      if (buttonId.startsWith('DECLINE_')) {
        const bookingId = buttonId.replace('DECLINE_', '');
        session.state = 'AWAITING_DECLINE_REASON';
        session.activeBookingId = bookingId;

        await sendTextMessage(
          sender,
          '❌ You declined the estimation.\nPlease reply with your reason (e.g. price high, repair later, not needed):'
        );
        return;
      }

      // --------------------------------------------------
      // STEP 4: PAYMENT CONFIRMATION (CUSTOMER OR TECH)
      // --------------------------------------------------
      if (
        buttonId.startsWith('PAID_ONLINE_') ||
        buttonId.startsWith('PAID_CASH_') ||
        buttonId.startsWith('TECH_CONFIRM_PAY_') ||
        buttonId.startsWith('TECH_CASH_PAY_')
      ) {
        let bookingId = buttonId.replace(/^(PAID_ONLINE_|PAID_CASH_|TECH_CONFIRM_PAY_|TECH_CASH_PAY_)/, '');
        const booking = bookings[bookingId];

        if (booking && booking.status !== 'COMPLETED') {
          booking.status = 'COMPLETED';
          const paymentMode = buttonId.includes('CASH') ? 'Cash' : 'Online / UPI';

          // Acknowledge Customer
          await sendTextMessage(
            booking.customerPhone,
            `🎉 Payment of *₹${booking.totalAmount}* (${paymentMode}) confirmed! Thank you for using GharGarage.`
          );

          // Acknowledge Technician
          await sendTextMessage(
            booking.technicianPhone,
            `💰 Payment of *₹${booking.totalAmount}* (${paymentMode}) confirmed for #${bookingId}. Job is complete!`
          );

          // Alert Admin
          await sendTextMessage(
            ADMIN_PHONE,
            `💰 *PAYMENT CONFIRMED #${bookingId}*\nAmount: ₹${booking.totalAmount}\nMode: ${paymentMode}\nCustomer: +${booking.customerPhone}`
          );

          // Trigger Step 5: Customer Review
          await sendReviewRequest(booking.customerPhone, bookingId);
        }
        return;
      }

      // --------------------------------------------------
      // STEP 5: CUSTOMER REVIEW
      // --------------------------------------------------
      if (buttonId.startsWith('RATE_')) {
        const parts = buttonId.split('_');
        const stars = parts[1];
        const bookingId = parts[2];

        await sendTextMessage(
          sender,
          `Thank you for your rating (${stars} ⭐)! We look forward to serving you again.`
        );

        await sendTextMessage(
          ADMIN_PHONE,
          `🌟 *REVIEW RECEIVED #${bookingId}*\nCustomer: +${sender}\nRating: ${stars} Stars`
        );
        return;
      }

      // Vehicle & Service Selection
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

      if (buttonId === 'SERVICE_WASH') {
        session.service = 'Doorstep Foam Wash';
        const price = session.vehicle === 'Car' ? '₹399' : '₹199';
        await sendButtons(
          sender,
          `Doorstep Foam Wash for ${session.vehicle}:\n💰 Rate: ${price} (Includes exterior wash & interior clean).\n\nConfirm booking?`,
          [
            { id: 'WASH_ACCEPT', title: '✅ Accept' },
            { id: 'WASH_DECLINE', title: '❌ Decline' },
          ]
        );
        return;
      }

      if (buttonId === 'WASH_ACCEPT') {
        session.state = 'AWAITING_LOCATION';
        await sendTextMessage(
          sender,
          'Awesome! Your wash booking is confirmed. 🧼\nPlease send your street address or live WhatsApp location pin:'
        );
        return;
      }

      if (buttonId === 'WASH_DECLINE') {
        session.state = 'IDLE';
        await sendTextMessage(sender, 'No problem! Feel free to reach out anytime.');
        return;
      }

      if (buttonId === 'SERVICE_REPAIR') {
        session.service = 'Doorstep Inspection & Repair';
        session.state = 'AWAITING_LOCATION';
        await sendTextMessage(
          sender,
          `Got it! For ${session.vehicle} Service & Repair, our technician will visit your doorstep for inspection.\n\nPlease send your street address or live WhatsApp location pin:`
        );
        return;
      }
    }

    // ====================================================
    // B. IMAGE MESSAGES (PRE- & POST-SERVICE PHOTOS)
    // ====================================================
    if (msgType === 'image') {
      const techBooking = getActiveBookingForTechnician(sender);

      if (techBooking) {
        const imageId = message.image.id;

        // Stage 1: Pre-service photos
        if (techBooking.status === 'AWAITING_PRE_PHOTOS') {
          techBooking.prePhotos = techBooking.prePhotos || [];
          techBooking.prePhotos.push(imageId);
          techBooking.status = 'AWAITING_ESTIMATION';

          await sendTextMessage(
            sender,
            `✅ *Pre-service photo recorded!*\n\n` +
            `Now inspect the vehicle and reply with the required parts and estimated total in this format:\n\n` +
            `*<Parts List> | <Total Amount>*\n\n` +
            `*Example:*\n` +
            `Engine oil, Front brake pads | 1450`
          );
          return;
        }

        // Stage 2: Post-service photos (Triggers Action Items to Both)
        if (techBooking.status === 'IN_PROGRESS' || techBooking.status === 'AWAITING_POST_PHOTOS') {
          techBooking.postPhotos = techBooking.postPhotos || [];
          techBooking.postPhotos.push(imageId);
          techBooking.status = 'AWAITING_PAYMENT';

          // Call handler that sends QR code, bill, and buttons to both customer & technician
          await presentPostServiceActionItems(techBooking);
          return;
        }

        // Additional photo sent while awaiting payment
        if (techBooking.status === 'AWAITING_PAYMENT') {
          techBooking.postPhotos.push(imageId);
          await sendTextMessage(sender, '📸 Additional vehicle photo saved.');
          return;
        }
      }
    }

    // ====================================================
    // C. TEXT / LOCATION INPUTS
    // ====================================================

    // Decline reason input
    if (msgType === 'text' && session.state === 'AWAITING_DECLINE_REASON') {
      const declineReason = message.text.body.trim();
      const booking = bookings[session.activeBookingId];

      if (booking) {
        booking.status = 'CANCELLED';
        booking.declineReason = declineReason;

        await sendTextMessage(
          sender,
          `Thank you for your feedback. Booking #${booking.id} has been cancelled.`
        );

        if (booking.technicianPhone) {
          await sendTextMessage(
            booking.technicianPhone,
            `⚠️ *ESTIMATE DECLINED*\nCustomer declined #${booking.id}.\nReason: "${declineReason}"\nJob is closed.`
          );
        }

        await sendTextMessage(
          ADMIN_PHONE,
          `⚠️ *BOOKING DECLINED #${booking.id}*\nCustomer: +${sender}\nReason: "${declineReason}"`
        );
      }

      session.state = 'IDLE';
      session.activeBookingId = null;
      return;
    }

    // Technician enters parts & estimate
    if (msgType === 'text' && activeTechnician) {
      const techBooking = getActiveBookingForTechnician(sender);

      if (techBooking && techBooking.status === 'AWAITING_ESTIMATION') {
        const { partsList, totalAmount } = parseEstimationText(message.text.body.trim());

        techBooking.partsList = partsList;
        techBooking.totalAmount = totalAmount;
        techBooking.status = 'AWAITING_APPROVAL';

        await sendTextMessage(
          sender,
          `📋 Estimation Slip created (Total: ₹${totalAmount}). Sent to customer for approval. Please wait.`
        );

        await sendEstimationSlip(
          techBooking.customerPhone,
          techBooking.id,
          partsList,
          totalAmount
        );
        return;
      }
    }

    // Customer provides address / location
    if (session.state === 'AWAITING_LOCATION') {
      let customerLocation = '';

      if (msgType === 'text') {
        customerLocation = message.text.body.trim();
      } else if (msgType === 'location') {
        const loc = message.location;
        const namePart = loc.name ? ` (${loc.name})` : '';
        const addressPart = loc.address ? ` - ${loc.address}` : '';
        customerLocation = `Lat: ${loc.latitude}, Long: ${loc.longitude}${namePart}${addressPart} (https://maps.google.com/?q=${loc.latitude},${loc.longitude})`;
      }

      if (customerLocation) {
        const bookingId = 'GG' + Math.floor(1000 + Math.random() * 9000);
        bookings[bookingId] = {
          id: bookingId,
          customerPhone: sender,
          vehicle: session.vehicle || 'Car',
          service: session.service || 'Doorstep Service',
          location: customerLocation,
          status: 'DISPATCHED',
          technicianPhone: null,
          totalAmount: session.service === 'Doorstep Foam Wash' ? (session.vehicle === 'Car' ? 399 : 199) : 0,
        };

        session.state = 'BOOKING_DISPATCHED';
        session.activeBookingId = bookingId;

        await sendTextMessage(
          sender,
          `Thank you! Your booking ID is *#${bookingId}*.\nFinding and alerting the nearest certified technician now... 🔍`
        );

        const qualifiedTechs = getAvailableTechniciansForVehicle(bookings[bookingId].vehicle);

        const jobText =
`🚨 *NEW GHARGARAGE JOB ALERT!*
*Job ID:* #${bookingId}
*Vehicle:* ${bookings[bookingId].vehicle}
*Service:* ${bookings[bookingId].service}
*Customer:* +${sender}
*Address:* ${customerLocation}
--------------------------------
Would you like to accept this job?`;

        for (const tech of qualifiedTechs) {
          await sendButtons(tech.phone, jobText, [
            { id: `TECH_ACCEPT_${bookingId}`, title: '✅ Accept Job' },
            { id: `TECH_DECLINE_${bookingId}`, title: '❌ Decline Job' },
          ]);
        }
        return;
      }
    }

    // Default / Greeting
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
  } catch (error) {
    console.error('Error in webhook processor:', error);
  }
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GharGarage Server running on port ${PORT}`);
});
