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
  try {
    // Get user state
    const userSnapshot = await get(child(ref(db), `users/${from}`));
    const user = userSnapshot.val();
    
    if (!user) {
      twiml.message('❓ Invalid command. Reply "menu" for options.');
      return;
    }

    // Handle report submission
    if (user.action === 'report_lost' || user.action === 'report_found') {
      const parts = msg.split(',');
      if (parts.length < 2) {
        twiml.message('⚠️ Format error. Please use: ITEM, LOCATION');
        return;
      }
      
      const item = parts[0].trim();
      const location = parts[1].trim();
      const description = parts.slice(2).join(',').trim() || 'No description';
      
      try {
        // Save to Firebase
        const newReportRef = push(ref(db, 'reports'));
        await set(newReportRef, {
          type: user.action.replace('report_', ''),
          item,
          location,
          description,
          reporter: from,
          timestamp: new Date().toISOString()
        });

        // Send confirmation
        twiml.message(`✅ **Kwasu Lost And Found Bot**\n${user.action === 'report_lost' ? 'Lost' : 'Found'} item reported!\n\nItem: ${item}\nLocation: ${location}\nDescription: ${description}`);
        
        // Clear user state
        remove(ref(db, `users/${from}`));
      } catch (error) {
        console.error('Firebase save error:', error);
        twiml.message('❌ Error saving report. Please try again.');
      }
    }
    
    // Handle search
    else if (user.action === 'search') {
      try {
        const reportsSnapshot = await get(child(ref(db), 'reports'));
        const reports = reportsSnapshot.val();
        
        if (!reports || Object.keys(reports).length === 0) {
          twiml.message('❌ No items found in the database.');
          return;
        }

        let response = `🔍 **Kwasu Lost And Found Bot**\nFound items matching "${msg}":\n\n`;
        let found = false;
        
        // Search in item names, locations, and descriptions
        Object.entries(reports).forEach(([key, report]) => {
          const searchText = `${report.item} ${report.location} ${report.description}`.toLowerCase();
          if (searchText.includes(msg.toLowerCase())) {
            found = true;
            response += `📦 ${report.item}\n📍 ${report.location}\n📝 ${report.description}\n⏰ ${new Date(report.timestamp).toLocaleString()}\n\n`;
          }
        });
        
        if (!found) {
          response = `❌ No items found matching "${msg}".\n\nTry searching with different keywords or check the spelling.`;
        }
        
        twiml.message(response);
        remove(ref(db, `users/${from}`));
      } catch (error) {
        console.error('Firebase search error:', error);
        twiml.message('❌ Error searching items. Please try again.');
      }
    }
  } catch (error) {
    console.error('Handle response error:', error);
    twiml.message('❌ An error occurred. Please try again.');
  }
}

const PORT = process.env.PORT || 3000;
expressApp.listen(PORT, () => console.log('Kwasu Lost And Found Bot running!'));
