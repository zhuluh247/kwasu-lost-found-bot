const express = require('express');
const twilio = require('twilio');
const firebase = require('firebase/app');
require('firebase/database');
require('dotenv').config();

// Initialize Firebase
const firebaseConfig = {
  databaseURL: process.env.FIREBASE_DATABASE_URL
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// Initialize Express
const app = express();
app.use(express.urlencoded({ extended: true }));

// Handle WhatsApp messages
app.post('/whatsapp', (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const msg = req.body.Body.toLowerCase();
  const from = req.body.From;

  // Main menu
  if (msg === 'menu') {
    twiml.message(`📋 **Kwasu Lost And Found Bot** Menu:
1. Report Lost Item
2. Report Found Item
3. Search Items
Reply with 1, 2, or 3.`);
  } 
  // Report lost
  else if (msg === '1') {
    twiml.message('🔍 **Kwasu Lost And Found Bot**\nReply with: ITEM, LOCATION (e.g., "Water Bottle, Library")');
    db.ref(`users/${from}`).set({ action: 'report_lost' });
  }
  // Report found
  else if (msg === '2') {
    twiml.message('🎁 **Kwasu Lost And Found Bot**\nReply with: ITEM, LOCATION (e.g., "Keys, Cafeteria")');
    db.ref(`users/${from}`).set({ action: 'report_found' });
  }
  // Search
  else if (msg === '3') {
    twiml.message('🔎 **Kwasu Lost And Found Bot**\nReply with a keyword (e.g., "water", "keys")');
    db.ref(`users/${from}`).set({ action: 'search' });
  }
  // Handle responses
  else {
    handleResponse(from, msg, twiml);
  }

  res.type('text/xml').send(twiml.toString());
});

async function handleResponse(from, msg, twiml) {
  const user = (await db.ref(`users/${from}`).once('value')).val();
  if (!user) {
    twiml.message('❓ Invalid command. Reply "menu" for options.');
    return;
  }

  // Save report
  if (user.action.includes('report')) {
    const [item, location] = msg.split(',').map(s => s.trim());
    if (!item || !location) {
      twiml.message('⚠️ Format error. Use: ITEM, LOCATION');
      return;
    }

    await db.ref('reports').push({
      type: user.action === 'report_lost' ? 'lost' : 'found',
      item,
      location,
      reporter: from,
      timestamp: new Date().toISOString()
    });

    twiml.message(`✅ **Kwasu Lost And Found Bot**\n${user.action === 'report_lost' ? 'Lost' : 'Found'} item reported!`);
    db.ref(`users/${from}`).remove();
  }
  // Search
  else if (user.action === 'search') {
    const reports = (await db.ref('reports').orderByChild('item').equalTo(msg).once('value')).val();
    if (!reports) {
      twiml.message('❌ No items found.');
      return;
    }

    let response = `🔍 **Kwasu Lost And Found Bot**\nFound items matching "${msg}":\n\n`;
    Object.values(reports).forEach(report => {
      response += `📦 ${report.item}\n📍 ${report.location}\n⏰ ${new Date(report.timestamp).toLocaleString()}\n\n`;
    });
    twiml.message(response);
    db.ref(`users/${from}`).remove();
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Kwasu Lost And Found Bot running!'));