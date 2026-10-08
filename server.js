const express = require('express');
const app = express();
app.use(express.json());

// STEP 1 TOKEN: Your custom password (make sure this matches Meta)
const VERIFY_TOKEN = 'GharGarage_Secret_777';

// 1. Handshake Endpoint (Meta calls this on "Verify and Save")
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

// 2. Message Receiving Endpoint (Meta posts customer chats & button clicks here)
app.post('/webhook', (req, res) => {
  const body = req.body;
  console.log('New incoming WhatsApp message:', JSON.stringify(body, null, 2));
  res.status(200).send('EVENT_RECEIVED');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GharGarage Server listening on port ${PORT}`));
