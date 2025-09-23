const express = require('express');
const twilio = require('twilio');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, push, set, get, child, remove } = require('firebase/database');
require('dotenv').config();

// Initialize Firebase
const firebaseConfig = {
  databaseURL: process.env.FIREBASE_DATABASE_URL
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// Initialize Express
const expressApp = express();
expressApp.use(express.urlencoded({ extended: true }));

// Handle WhatsApp messages
expressApp.post('/whatsapp', (req, res) => {
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
    set(ref(db, `users/${from}`), { action: 'report_lost' });
  }
  // Report found
  else if (msg === '2') {
    twiml.message('🎁 **Kwasu Lost And Found Bot**\nReply with: ITEM, LOCATION (e.g., "Keys, Cafeteria")');
    set(ref(db, `users/${from}`), { action: 'report_found' });
  }
  // Search
  else if (msg === '3') {
    twiml.message('🔎 **Kwasu Lost And Found Bot**\nReply with a keyword (e.g., "water", "keys")');
    set(ref(db, `users/${from}`), { action: 'search' });
  }
  // Handle responses
  else {
    handleResponse(from, msg, twiml);
  }

  res.type('text/xml').send(twiml.toString());
});

async function handleResponse(from, msg, twiml) {
  const userSnapshot = await get(child(ref(db), `users/${from}`));
  const user = userSnapshot.val();
  
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

    const newReportRef = push(ref(db, 'reports'));
    await set(newReportRef, {
      type: user.action === 'report_lost' ? 'lost' : 'found',
      item,
      location,
      reporter: from,
      timestamp: new Date().toISOString()
    });

    twiml.message(`✅ **Kwasu Lost And Found Bot**\n${user.action === 'report_lost' ? 'Lost' : 'Found'} item reported!`);
    remove(ref(db, `users/${from}`));
  }
  // Search
  else if (user.action === 'search') {
    const reportsSnapshot = await get(child(ref(db), 'reports'));
    const reports = reportsSnapshot.val();
    
    if (!reports) {
      twiml.message('❌ No items found.');
      return;
    }

    let response = `🔍 **Kwasu Lost And Found Bot**\nFound items matching "${msg}":\n\n`;
    let found = false;
    
    Object.entries(reports).forEach(([key, report]) => {
      if (report.item.toLowerCase().includes(msg)) {
        found = true;
        response += `📦 ${report.item}\n📍 ${report.location}\n⏰ ${new Date(report.timestamp).toLocaleString()}\n\n`;
      }
    });
    
    if (!found) {
      response = `❌ No items found matching "${msg}".`;
    }
    
    twiml.message(response);
    remove(ref(db, `users/${from}`));
  }
}

const PORT = process.env.PORT || 3000;
expressApp.listen(PORT, () => console.log('Kwasu Lost And Found Bot running!'));
