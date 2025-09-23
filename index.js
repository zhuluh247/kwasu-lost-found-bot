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
  const msg = req.body.Body.toLowerCase().trim(); // Added trim() to remove extra spaces
  const from = req.body.From;

  // Debug log
  console.log(`Received message: "${msg}" from ${from}`);

  try {
    // Main menu - simplified condition
    if (msg === 'menu') {
      console.log('Processing menu command');
      const menuMessage = `📋 *Welcome to Kwasu Lost And Found Bot!*\n_v0.1 Designed & Developed by_ Rugged of ICT.\n\nTo proceed with, Select what you are here for from the menu:\n\n1. *Report Lost Item*\n2. *Report Found Item*\n3. *Search for my lost Item*\n\nKindly Reply with 1, 2, or 3.`;
      twiml.message(menuMessage);
      console.log('Menu message sent');
    } 
    // Report lost
    else if (msg === '1') {
      console.log('Processing report lost command');
      twiml.message('🔍 *Report Lost Item*\n\nPlease provide the following details:\nITEM, LOCATION, DESCRIPTION\n\nExample: "Water Bottle, Library, Blue with sticker"');
      await set(ref(db, `users/${from}`), { action: 'report_lost' });
    }
    // Report found
    else if (msg === '2') {
      console.log('Processing report found command');
      twiml.message('🎁 *Report Found Item*\n\nPlease provide the following details:\nITEM, LOCATION, CONTACT_PHONE\n\nExample: "Keys, Cafeteria, 08012345678"');
      await set(ref(db, `users/${from}`), { action: 'report_found' });
    }
    // Search
    else if (msg === '3') {
      console.log('Processing search command');
      twiml.message('🔎 *Search for my lost Item*\n\nPlease reply with a keyword to search:\n\nExample: "water", "keys", "bag"');
      await set(ref(db, `users/${from}`), { action: 'search' });
    }
    // Handle responses
    else {
      console.log('Processing other command:', msg);
      await handleResponse(from, msg, twiml);
    }

    console.log('Sending response');
    res.type('text/xml').send(twiml.toString());
  } catch (error) {
    console.error('Main handler error:', error);
    twiml.message('❌ An error occurred. Please try again.');
    res.type('text/xml').send(twiml.toString());
  }
});

async function handleResponse(from, msg, twiml) {
  try {
    console.log(`Handling response for: ${msg}`);
    // Get user state
    const userSnapshot = await get(child(ref(db), `users/${from}`));
    const user = userSnapshot.val();
    
    if (!user) {
      console.log('No user state found, sending invalid command');
      twiml.message('❓ Invalid command. Reply "menu" for options.');
      return;
    }

    console.log('User state:', user);

    // Handle report submission
    if (user.action === 'report_lost' || user.action === 'report_found') {
      const parts = msg.split(',');
      if (parts.length < 3) {
        twiml.message(`⚠️ Format error. Please use: ${user.action === 'report_lost' ? 'ITEM, LOCATION, DESCRIPTION' : 'ITEM, LOCATION, CONTACT_PHONE'}`);
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
      if (user.action === 'report_lost') {
        // Enhanced confirmation for lost items
        let confirmationMsg = `✅ *Lost Item Reported Successfully!*\n\n`;
        confirmationMsg += `📦 *Item:* ${item}\n`;
        confirmationMsg += `📍 *Location:* ${location}\n`;
        confirmationMsg += `📝 *Description:* ${reportData.description}\n\n`;
        confirmationMsg += `🔍 *We're searching for matching found items...*\n\n`;
        
        // Check for matching found items
        const foundItems = await findMatchingFoundItems(item);
        if (foundItems.length > 0) {
          confirmationMsg += `🎉 *Good news!* We found ${foundItems.length} matching item(s) that were reported found:\n\n`;
          foundItems.forEach((item, index) => {
            confirmationMsg += `${index + 1}. *${item.item}*\n`;
            confirmationMsg += `   📍 Location: ${item.location}\n`;
            confirmationMsg += `   📞 Contact: ${item.contact_phone}\n`;
            confirmationMsg += `   📝 ${item.description}\n`;
            confirmationMsg += `   ⏰ ${new Date(item.timestamp).toLocaleString()}\n\n`;
          });
          
          confirmationMsg += `💡 *Tip:* When contacting, please provide details about your lost item to verify ownership.\n\n`;
        } else {
          confirmationMsg += `😔 *No matching found items yet.*\n\n`;
          confirmationMsg += `💡 *What to do next:*\n`;
          confirmationMsg += `• Check back regularly for updates\n`;
          confirmationMsg += `• Spread the word about your lost item\n`;
          confirmationMsg += `• Contact locations where you might have lost it\n\n`;
        }
        
        confirmationMsg += `🙏 *Thank you for using KWASU Lost & Found Bot!*`;
        twiml.message(confirmationMsg);
      } else {
        // Confirmation with safety warning for found items
        let confirmationMsg = `✅ *Found Item Reported Successfully!*\n\n`;
        confirmationMsg += `📦 *Item:* ${item}\n`;
        confirmationMsg += `📍 *Location:* ${location}\n`;
        confirmationMsg += `📞 *Contact:* ${reportData.contact_phone}\n`;
        confirmationMsg += `📝 *Description:* ${reportData.description}\n\n`;
        
        // Safety warning
        confirmationMsg += `⚠️ *IMPORTANT SAFETY NOTICE:*\n\n`;
        confirmationMsg += `When someone contacts you to claim this item, please:\n\n`;
        confirmationMsg += `🔐 *Ask for verification* - Request specific details about the item such as:\n`;
        confirmationMsg += `• Exact color\n`;
        confirmationMsg += `• Shape or size\n`;
        confirmationMsg += `• Visible marks, scratches, or unique features\n`;
        confirmationMsg += `• Contents (if applicable)\n\n`;
        confirmationMsg += `🚫 *Report false claimants* - If someone provides incorrect details:\n`;
        confirmationMsg += `• Do not return the item\n`;
        confirmationMsg += `• Contact KWASU WORKS immediately\n`;
        confirmationMsg += `• Provide the claimant's phone number\n\n`;
        confirmationMsg += `🛡️ *This helps maintain a safe community and prevents fraud.*\n\n`;
        confirmationMsg += `🙏 *Thank you for your honesty and for helping others!*`;
        
        twiml.message(confirmationMsg);
      }
      
      // Clear user state
      await remove(ref(db, `users/${from}`));
    }
    
    // Handle search
    else if (user.action === 'search') {
      const reportsSnapshot = await get(child(ref(db), 'reports'));
      const reports = reportsSnapshot.val();
      
      if (!reports || Object.keys(reports).length === 0) {
        twiml.message('❌ No items found in the database.');
        return;
      }

      let response = `🔎 *Search Results*\n\nFound items matching "${msg}":\n\n`;
      let found = false;
      
      // Search in item names, locations, and descriptions
      Object.entries(reports).forEach(([key, report]) => {
        const searchText = `${report.item} ${report.location} ${report.description}`.toLowerCase();
        if (searchText.includes(msg.toLowerCase())) {
          found = true;
          response += `📦 *${report.item}*\n`;
          response += `📍 Location: ${report.location}\n`;
          response += `📝 ${report.description}`;
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
    const reportsSnapshot = await get(child(ref(db), 'reports'));
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
