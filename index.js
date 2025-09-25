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
expressApp.post('/whatsapp', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const msg = req.body.Body.toLowerCase().trim();
  const from = req.body.From;

  try {
    // Main menu
    if (msg === 'menu') {
      twiml.message(`📋 *Welcome to Kwasu Lost And Found Bot!*\n_v0.1 Designed & Developed by_ Rugged of ICT.\n\nTo proceed with, Select what you are here for from the menu:\n\n1. *Report Lost Item*\n2. *Report Found Item*\n3. *Search for my lost Item*\n\nQuick Actions: menu, about\n\nKindly Reply with 1, 2, or 3.`);
    } 
    // About
    else if (msg === 'about') {
      twiml.message(`ℹ️ *About KWASU Lost And Found Bot*\n\n*Developer:* MUHAMMED ZULU AKINKUNMI (Rugged)\n*Department:* Computer Science, KWASU\n\nThis bot is dedicated to helping KWASU students recover their lost items and return found items to their rightful owners.`);
    }
    // Report lost
    else if (msg === '1') {
      twiml.message('🔍 *Report Lost Item*\n\nPlease provide: ITEM, LOCATION, DESCRIPTION\n\nExample: "Water Bottle, Library, Blue with sticker"');
      await set(ref(db, `users/${from}`), { action: 'report_lost' });
    }
    // Report found
    else if (msg === '2') {
      twiml.message('🎁 *Report Found Item*\n\nPlease provide: ITEM, LOCATION, CONTACT_PHONE\n\nExample: "Keys, Cafeteria, 08012345678"');
      await set(ref(db, `users/${from}`), { action: 'report_found' });
    }
    // Search
    else if (msg === '3') {
      twiml.message('🔎 *Search for my lost Item*\n\nPlease reply with a keyword to search:\n\nExample: "water", "keys", "bag"');
      await set(ref(db, `users/${from}`), { action: 'search' });
    }
    // Handle responses
    else {
      await handleResponse(from, msg, twiml);
    }

    res.type('text/xml').send(twiml.toString());
  } catch (error) {
    console.error('Main handler error:', error);
    twiml.message('❌ An error occurred. Please try again.');
    res.type('text/xml').send(twiml.toString());
  }
});

async function handleResponse(from, msg, twiml) {
  try {
    // Get user state
    const userSnapshot = await get(child(ref(db, `users/${from}`)));
    const user = userSnapshot.val();
    
    if (!user) {
      twiml.message('❓ Invalid command. Reply "menu" for options.');
      return;
    }

    // Handle report submission
    if (user.action === 'report_lost' || user.action === 'report_found') {
      const parts = msg.split(',');
      if (parts.length < 3) {
        twiml.message(`⚠️ Format error. Please use: ITEM, LOCATION, ${user.action === 'report_lost' ? 'DESCRIPTION' : 'CONTACT_PHONE'}`);
        return;
      }
      
      const item = parts[0].trim();
      const location = parts[1].trim();
      const thirdPart = parts[2].trim();
      
      let reportData = {
        type: user.action.replace('report_', ''),
        item,
        location,
        reporter: from,
        timestamp: new Date().toISOString()
      };
      
      if (user.action === 'report_lost') {
        reportData.description = parts.slice(2).join(',').trim();
      } else {
        reportData.contact_phone = thirdPart;
        reportData.description = parts.slice(3).join(',').trim() || 'No description';
      }
      
      // Save to Firebase
      const newReportRef = push(ref(db, 'reports'));
      await set(newReportRef, reportData);

      // Send confirmation
      let confirmationMsg = `✅ *${user.action === 'report_lost' ? 'Lost' : 'Found'} Item Reported Successfully!*\n\nItem: ${item}\nLocation: ${location}`;
      
      if (user.action === 'report_lost') {
        confirmationMsg += `\nDescription: ${reportData.description}`;
        
        // Check for matching found items
        const foundItems = await findMatchingFoundItems(item);
        if (foundItems.length > 0) {
          confirmationMsg += `\n\n🎉 Good news! We found ${foundItems.length} matching item(s) that were reported found:\n\n`;
          foundItems.forEach((item, index) => {
            confirmationMsg += `${index + 1}. ${item.item}\n   📍 Location: ${item.location}\n   📞 Contact: ${item.contact_phone}\n   📝 ${item.description}\n   ⏰ ${new Date(item.timestamp).toLocaleString()}\n\n`;
          });
        }
      } else {
        confirmationMsg += `\n📞 Contact: ${reportData.contact_phone}\nDescription: ${reportData.description}`;
      }
      
      twiml.message(confirmationMsg);
      
      // Clear user state
      await remove(ref(db, `users/${from}`));
    }
    
    // Handle search
    else if (user.action === 'search') {
      const reportsSnapshot = await get(child(ref(db, 'reports')));
      const reports = reportsSnapshot.val();
      
      if (!reports || Object.keys(reports).length === 0) {
        twiml.message('❌ No items found in the database.');
        return;
      }

      let response = `🔎 *Search Results*\n\nFound items matching "${msg}":\n\n`;
      let found = false;
      
      Object.entries(reports).forEach(([key, report]) => {
        const searchText = `${report.item} ${report.location} ${report.description}`.toLowerCase();
        if (searchText.includes(msg.toLowerCase())) {
          found = true;
          response += `📦 ${report.item}\n📍 Location: ${report.location}\n📝 ${report.description}`;
          if (report.type === 'found') {
            response += `\n📞 Contact: ${report.contact_phone}`;
          }
          response += `\n⏰ ${new Date(report.timestamp).toLocaleString()}\n\n`;
        }
      });
      
      if (!found) {
        response = `❌ No items found matching "${msg}".\n\nTry searching with different keywords or check the spelling.`;
      }
      
      twiml.message(response);
      await remove(ref(db, `users/${from}`));
    }
  } catch (error) {
    console.error('Handle response error:', error);
    twiml.message('❌ An error occurred. Please try again.');
  }
}

// Helper function to find matching found items
async function findMatchingFoundItems(searchItem) {
  try {
    const reportsSnapshot = await get(child(ref(db, 'reports')));
    const reports = reportsSnapshot.val();
    
    if (!reports) return [];
    
    const searchKeywords = searchItem.toLowerCase().split(' ');
    const matchingItems = [];
    
    Object.entries(reports).forEach(([key, report]) => {
      if (report.type === 'found') {
        const reportText = `${report.item} ${report.description}`.toLowerCase();
        const matchScore = searchKeywords.reduce((score, keyword) => {
          return score + (reportText.includes(keyword) ? 1 : 0);
        }, 0);
        
        if (matchScore > 0) {
          matchingItems.push({...report, matchScore});
        }
      }
    });
    
    // Sort by match score (highest first)
    return matchingItems.sort((a, b) => b.matchScore - a.matchScore);
  } catch (error) {
    console.error('Error finding matching items:', error);
    return [];
  }
}

const PORT = process.env.PORT || 3000;
expressApp.listen(PORT, () => console.log('Kwasu Lost And Found Bot running!'));
