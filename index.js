const express = require('express');
const twilio = require('twilio');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, push, set, get, child, remove, update } = require('firebase/database');
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

// Helper function to generate verification code
function generateVerificationCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Handle WhatsApp messages
expressApp.post('/whatsapp', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const msg = req.body.Body.toLowerCase();
  const from = req.body.From;

  try {
    // Main menu
    if (msg === 'menu') {
      twiml.message(`📋 *Welcome to Kwasu Lost And Found Bot!*\n_v0.2 Designed & Developed by_ Rugged of ICT.\n\nTo proceed with, Select what you are here for from the menu:\n\n1. *Report Lost Item*\n2. *Report Found Item*\n3. *Search for my lost Item*\n4. *My Reports*\n\nKindly Reply with 1, 2, 3, or 4.`);
    } 
    // Report lost
    else if (msg === '1') {
      twiml.message('🔍 *Report Lost Item*\n\nPlease provide the following details:\nITEM, LOCATION, DESCRIPTION\n\nExample: "Water Bottle, Library, Blue with sticker"');
      await set(ref(db, `users/${from}`), { action: 'report_lost' });
    }
    // Report found
    else if (msg === '2') {
      twiml.message('🎁 *Report Found Item*\n\nPlease provide the following details:\nITEM, LOCATION, CONTACT_PHONE\n\nExample: "Keys, Cafeteria, 08012345678"');
      await set(ref(db, `users/${from}`), { action: 'report_found' });
    }
    // Search
    else if (msg === '3') {
      twiml.message('🔎 *Search for my lost Item*\n\nPlease reply with a keyword to search:\n\nExample: "water", "keys", "bag"');
      await set(ref(db, `users/${from}`), { action: 'search' });
    }
    // My Reports
    else if (msg === '4') {
      await showUserReports(from, twiml);
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

async function showUserReports(from, twiml) {
  try {
    const reportsRef = ref(db, 'reports');
    const reportsSnapshot = await get(reportsRef);
    const reports = reportsSnapshot.val();
    
    if (!reports || Object.keys(reports).length === 0) {
      twiml.message('❌ You have not reported any items yet.\n\nUse the menu to report a lost or found item.');
      await set(ref(db, `users/${from}`), { action: 'menu' });
      return;
    }
    
    let response = `📋 *Your Reports*\n\n`;
    let hasReports = false;
    let reportNumbers = [];
    
    Object.entries(reports).forEach(([key, report]) => {
      if (report.reporter === from) {
        hasReports = true;
        const date = new Date(report.timestamp).toLocaleString();
        reportNumbers.push(key);
        
        if (report.type === 'lost') {
          const status = report.recovered ? '✅ Recovered' : '❌ Not Recovered';
          response += `${reportNumbers.length}. 🔍 *Lost Item: ${report.item}*\n`;
          response += `📍 Location: ${report.location}\n`;
          response += `📅 Reported: ${date}\n`;
          response += `📊 Status: ${status}\n`;
          response += `🔐 Verification Code: ${report.verification_code}\n\n`;
          
          if (!report.recovered) {
            response += `💡 Reply with *${reportNumbers.length}* to mark as recovered\n\n`;
          }
        } else {
          const status = report.claimed ? '✅ Claimed' : '❌ Not Claimed';
          response += `${reportNumbers.length}. 🎁 *Found Item: ${report.item}*\n`;
          response += `📍 Location: ${report.location}\n`;
          response += `📅 Reported: ${date}\n`;
          response += `📊 Status: ${status}\n`;
          response += `🔐 Verification Code: ${report.verification_code}\n\n`;
          
          if (!report.claimed) {
            response += `💡 Reply with *${reportNumbers.length}* to mark as claimed\n\n`;
          }
        }
      }
    });
    
    if (!hasReports) {
      response = '❌ You have not reported any items yet.\n\nUse the menu to report a lost or found item.';
    } else {
      response += `💡 To manage a report, reply with its number (1, 2, 3...)\n`;
      response += `💡 Reply *menu* to return to main menu`;
    }
    
    twiml.message(response);
    
    // Store report numbers for later reference
    if (hasReports) {
      await set(ref(db, `users/${from}`), { 
        action: 'select_report',
        reportIds: reportNumbers
      });
    } else {
      await set(ref(db, `users/${from}`), { action: 'menu' });
    }
  } catch (error) {
    console.error('Show user reports error:', error);
    twiml.message('❌ An error occurred while fetching your reports. Please try again.');
    await set(ref(db, `users/${from}`), { action: 'menu' });
  }
}

async function handleResponse(from, msg, twiml) {
  try {
    // Get user state
    const userSnapshot = await get(child(ref(db), `users/${from}`));
    const user = userSnapshot.val();
    
    if (!user) {
      twiml.message('❓ Invalid command. Reply "menu" for options.');
      return;
    }

    // Handle report selection
    if (user.action === 'select_report') {
      const reportNumber = parseInt(msg);
      if (isNaN(reportNumber) || reportNumber < 1 || reportNumber > user.reportIds.length) {
        twiml.message(`❌ Invalid selection. Please enter a number between 1 and ${user.reportIds.length}, or reply "menu" to return.`);
        return;
      }
      
      const reportId = user.reportIds[reportNumber - 1];
      const reportRef = ref(db, `reports/${reportId}`);
      const reportSnapshot = await get(reportRef);
      const report = reportSnapshot.val();
      
      if (!report) {
        twiml.message('❌ Report not found. It may have been deleted.');
        await set(ref(db, `users/${from}`), { action: 'menu' });
        return;
      }
      
      if (report.reporter !== from) {
        twiml.message('❌ You are not authorized to modify this report.');
        await set(ref(db, `users/${from}`), { action: 'menu' });
        return;
      }
      
      // Check if already recovered/claimed
      if ((report.type === 'lost' && report.recovered) || (report.type === 'found' && report.claimed)) {
        const status = report.type === 'lost' ? 'recovered' : 'claimed';
        twiml.message(`❌ This item has already been marked as ${status}.`);
        await set(ref(db, `users/${from}`), { action: 'menu' });
        return;
      }
      
      // Ask for verification code
      const statusType = report.type === 'lost' ? 'recovered' : 'claimed';
      twiml.message(`🔐 *Verification Required*\n\nTo mark this item as ${statusType}, please enter your verification code.\n\n📦 *Item:* ${report.item}\n📍 *Location:* ${report.location}\n\n⚠️ *Important:* This verification code was provided when you first reported the item. If you don't have it, please contact the developer.\n\nPlease reply with your 6-character verification code:`);
      
      await set(ref(db, `users/${from}`), { 
        action: 'verify_code',
        reportId: reportId,
        statusType: statusType
      });
    }
    
    // Handle verification code input
    else if (user.action === 'verify_code') {
      const verificationCode = msg.trim().toUpperCase();
      
      if (verificationCode.length !== 6) {
        twiml.message('❌ Invalid verification code format. Please enter the 6-character code provided when you reported the item.');
        return;
      }
      
      // Get the report
      const reportRef = ref(db, `reports/${user.reportId}`);
      const reportSnapshot = await get(reportRef);
      const report = reportSnapshot.val();
      
      if (!report) {
        twiml.message('❌ Report not found. It may have been deleted.');
        await set(ref(db, `users/${from}`), { action: 'menu' });
        return;
      }
      
      if (report.verification_code !== verificationCode) {
        twiml.message('❌ Incorrect verification code. Please try again or contact the developer if you forgot your code.');
        return;
      }
      
      // Update the report status
      const updateData = {};
      if (user.statusType === 'claimed') {
        updateData.claimed = true;
        updateData.claimed_at = new Date().toISOString();
      } else {
        updateData.recovered = true;
        updateData.recovered_at = new Date().toISOString();
      }
      
      await update(reportRef, updateData);
      
      // Send confirmation
      twiml.message(`✅ Item Successfully Marked as ${user.statusType === 'claimed' ? 'Claimed' : 'Recovered'}!\n\nItem: ${report.item}\nLocation: ${report.location}\n\nThank you for using this platform!`);
      
      // Clear user state
      await remove(ref(db, `users/${from}`));
    }
    
    // Handle report submission
    else if (user.action === 'report_lost' || user.action === 'report_found') {
      const parts = msg.split(',');
      if (parts.length < 3) {
        twiml.message(`⚠️ Format error. Please use: ${user.action === 'report_lost' ? 'ITEM, LOCATION, DESCRIPTION' : 'ITEM, LOCATION, CONTACT_PHONE'}`);
        return;
      }
      
      const item = parts[0].trim();
      const location = parts[1].trim();
      const thirdPart = parts[2].trim();
      
      // Generate verification code
      const verificationCode = generateVerificationCode();
      
      let reportData = {
        type: user.action.replace('report_', ''),
        item,
        location,
        reporter: from,
        verification_code: verificationCode,
        timestamp: new Date().toISOString()
      };
      
      if (user.action === 'report_lost') {
        reportData.description = parts.slice(2).join(',').trim();
        reportData.recovered = false;
      } else {
        reportData.contact_phone = thirdPart;
        reportData.description = parts.slice(3).join(',').trim() || 'No description';
        reportData.claimed = false;
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
        confirmationMsg += `📝 *Description:* ${reportData.description}\n`;
        confirmationMsg += `🔐 *Verification Code:* ${verificationCode}\n\n`;
        confirmationMsg += `💡 *Save this code - you'll need it to mark your item as recovered.*\n\n`;
        
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
        // Confirmation with safety warning for found items - SHORTENED VERSION
        let confirmationMsg = `✅ *Found Item Reported Successfully!*\n\n`;
        confirmationMsg += `📦 *Item:* ${item}\n`;
        confirmationMsg += `📍 *Location:* ${location}\n`;
        confirmationMsg += `📞 *Contact:* ${reportData.contact_phone}\n`;
        confirmationMsg += `📝 *Description:* ${reportData.description}\n`;
        confirmationMsg += `🔐 *Verification Code:* ${verificationCode}\n\n`;
        confirmationMsg += `💡 *Save this code - you'll need it to mark the item as claimed.*\n\n`;
        
        // SHORT SAFETY TIPS (just 2-3 lines)
        confirmationMsg += `⚠️ *Safety Tip:* Always verify ownership before returning items. Ask for specific details about the item to confirm it belongs to the claimant.`;
        
        twiml.message(confirmationMsg);
      }
      
      // Clear user state
      await remove(ref(db, `users/${from}`));
    }
    
    // Handle search
    else if (user.action === 'search') {
      const reportsRef = ref(db, 'reports');
      const reportsSnapshot = await get(reportsRef);
      const reports = reportsSnapshot.val();
      
      if (!reports || Object.keys(reports).length === 0) {
        twiml.message('❌ No items found in the database.');
        await remove(ref(db, `users/${from}`));
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
    const reportsRef = ref(db, 'reports');
    const reportsSnapshot = await get(reportsRef);
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
