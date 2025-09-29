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
  const msg = req.body.Body.trim();
  const from = req.body.From;

  try {
    // First check if user has an existing state
    const userSnapshot = await get(child(ref(db), `users/${from}`));
    const user = userSnapshot.val();

    // If user has an existing state, handle it directly
    if (user) {
      await handleResponse(from, msg, twiml);
      res.type('text/xml').send(twiml.toString());
      return;
    }

    // If no existing state, process menu commands
    if (msg.toLowerCase() === 'menu') {
      twiml.message(`📋 *Welcome to Kwasu Lost And Found Bot!*\n_v0.1 Designed & Developed by_ Rugged of ICT.\n\nTo proceed with, Select what you are here for from the menu:\n\n1. *Report Lost Item*\n2. *Report Found Item*\n3. *Search for my lost Item*\n4. *My Reports*\n\nKindly Reply with 1, 2, 3, or 4.`);
    } 
    else if (msg === '1') {
      twiml.message('🔍 *Report Lost Item*\n\nPlease provide the following details:\nITEM, LOCATION, DESCRIPTION\n\nExample: "Water Bottle, Library, Blue with sticker"');
      await set(ref(db, `users/${from}`), { action: 'report_lost' });
    }
    else if (msg === '2') {
      twiml.message('🎁 *Report Found Item*\n\nPlease provide the following details:\nITEM, LOCATION, CONTACT_PHONE\n\nExample: "Keys, Cafeteria, 08012345678"');
      await set(ref(db, `users/${from}`), { action: 'report_found' });
    }
    else if (msg === '3') {
      twiml.message('🔎 *Search for my lost Item*\n\nPlease reply with a keyword to search:\n\nExample: "water", "keys", "bag"');
      await set(ref(db, `users/${from}`), { action: 'search' });
    }
    else if (msg === '4') {
      await showUserReports(from, twiml);
    }
    else {
      twiml.message('❓ Invalid command. Reply "menu" for options.');
    }

    res.type('text/xml').send(twiml.toString());
  } catch (error) {
    console.error('Main handler error:', error);
    twiml.message('❌ Error. Please try again.');
    res.type('text/xml').send(twiml.toString());
  }
});

async function showUserReports(from, twiml) {
  try {
    const reportsRef = ref(db, 'reports');
    const reportsSnapshot = await get(reportsRef);
    const reports = reportsSnapshot.val();
    
    if (!reports || Object.keys(reports).length === 0) {
      twiml.message('❌ No reports found. Reply "menu" for options.');
      return;
    }
    
    let response = `📋 *Your Reports*\n\n`;
    let hasReports = false;
    let reportOptions = [];
    
    Object.entries(reports).forEach(([key, report]) => {
      if (report.reporter === from) {
        hasReports = true;
        const date = new Date(report.timestamp).toLocaleDateString();
        
        if (report.type === 'lost') {
          const status = report.recovered ? '✅ Recovered' : '❌ Not Recovered';
          response += `${reportOptions.length + 1}. *${report.item}*\n`;
          response += `Location: ${report.location}\n`;
          response += `Status: ${status}\n\n`;
          
          if (!report.recovered) {
            reportOptions.push({ id: key, text: `${reportOptions.length + 1}. ${report.item} (Lost)` });
          }
        } else {
          const status = report.claimed ? '✅ Claimed' : '❌ Not Claimed';
          response += `${reportOptions.length + 1}. *${report.item}*\n`;
          response += `Location: ${report.location}\n`;
          response += `Status: ${status}\n\n`;
          
          if (!report.claimed) {
            reportOptions.push({ id: key, text: `${reportOptions.length + 1}. ${report.item} (Found)` });
          }
        }
      }
    });
    
    if (!hasReports) {
      response = '❌ You have no reports. Reply "menu" to create one.';
      twiml.message(response);
      return;
    }
    
    if (reportOptions.length > 0) {
      response += 'To mark an item as recovered/claimed, reply with its number:\n\n';
      reportOptions.forEach(option => {
        response += `${option.text}\n`;
      });
      
      await set(ref(db, `users/${from}`), { 
        action: 'select_report',
        reports: reportOptions
      });
    } else {
      response += 'All items are resolved. Reply "menu" for options.';
    }
    
    twiml.message(response);
  } catch (error) {
    console.error('Show user reports error:', error);
    twiml.message('❌ Error fetching reports. Try again later.');
  }
}

async function handleResponse(from, msg, twiml) {
  try {
    // Get user state
    const userSnapshot = await get(child(ref(db), `users/${from}`));
    const user = userSnapshot.val();
    
    if (!user) {
      twiml.message('❓ Session expired. Reply "menu" for options.');
      return;
    }

    // Handle report selection
    if (user.action === 'select_report') {
      const reportNum = parseInt(msg);
      if (isNaN(reportNum) || reportNum < 1 || reportNum > user.reports.length) {
        twiml.message(`❌ Invalid selection. Choose 1-${user.reports.length} or reply "menu".`);
        return;
      }
      
      const selectedReport = user.reports[reportNum - 1];
      const reportRef = ref(db, `reports/${selectedReport.id}`);
      const reportSnapshot = await get(reportRef);
      const report = reportSnapshot.val();
      
      if (!report) {
        twiml.message('❌ Report not found. Reply "menu" for options.');
        return;
      }
      
      const statusType = report.type === 'lost' ? 'recovered' : 'claimed';
      
      // Show report details and ask for verification
      let message = `📋 *Report Details*\n\n`;
      message += `📦 *Item:* ${report.item}\n`;
      message += `📍 *Location:* ${report.location}\n`;
      message += `🔐 *Verification Code:* ${report.verification_code}\n`;
      
      if (report.type === 'lost') {
        message += `📝 *Description:* ${report.description}\n`;
        message += `📊 *Status:* ${report.recovered ? '✅ Recovered' : '❌ Not Recovered'}\n`;
      } else {
        message += `📞 *Contact:* ${report.contact_phone}\n`;
        message += `📝 *Description:* ${report.description}\n`;
        message += `📊 *Status:* ${report.claimed ? '✅ Claimed' : '❌ Not Claimed'}\n`;
      }
      
      message += `\nTo mark this item as ${statusType}, reply with your verification code:`;
      
      await set(ref(db, `users/${from}`), { 
        action: 'verify_code',
        reportId: selectedReport.id,
        statusType: statusType
      });
      
      twiml.message(message);
    }
    // Handle verification code input
    else if (user.action === 'verify_code') {
      const verificationCode = msg.trim().toUpperCase();
      
      if (verificationCode.length !== 6) {
        twiml.message('❌ Invalid code. Enter the 6-character code provided when you reported the item.');
        return;
      }
      
      // Get the report
      const reportRef = ref(db, `reports/${user.reportId}`);
      const reportSnapshot = await get(reportRef);
      const report = reportSnapshot.val();
      
      if (!report) {
        twiml.message('❌ Report not found. Reply "menu" for options.');
        return;
      }
      
      if (report.verification_code !== verificationCode) {
        twiml.message('❌ Incorrect code. Try again or contact developer if you forgot your code.');
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
      
      // Perform the update
      await update(reportRef, updateData);
      
      // Send confirmation
      twiml.message(`✅ Item marked as ${user.statusType}!\n\nItem: ${report.item}\nLocation: ${report.location}\n\nThank you for using this platform!`);
      
      // Clear user state
      await remove(ref(db, `users/${from}`));
    }
    // Handle report submission
    else if (user.action === 'report_lost' || user.action === 'report_found') {
      const parts = msg.split(',');
      if (parts.length < 3) {
        twiml.message(`⚠️ Format error. Use: ${user.action === 'report_lost' ? 'ITEM, LOCATION, DESCRIPTION' : 'ITEM, LOCATION, YOUR_PHONE'}`);
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
      
      // Verify the data was saved correctly
      const savedReportSnapshot = await get(newReportRef);
      const savedReport = savedReportSnapshot.val();
      
      if (!savedReport) {
        twiml.message('❌ Error saving your report. Please try again.');
        return;
      }

      // Send confirmation
      if (user.action === 'report_lost') {
        twiml.message(`✅ Lost item reported!\n\nItem: ${item}\nLocation: ${location}\nDescription: ${reportData.description}\n\nVerification Code: ${verificationCode}\n\nSave this code to mark as recovered later.`);
      } else {
        let confirmationMsg = `✅ Found item reported!\n\nItem: ${item}\nLocation: ${location}\nContact: ${reportData.contact_phone}\n\nVerification Code: ${verificationCode}\n\nSave this code to mark as claimed later.\n\n⚠️ *Tip:* When someone contacts to claim, ask for item details to verify ownership.`;
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
        twiml.message('❌ No items found. Reply "menu" for options.');
        return;
      }

      let response = `🔎 Search Results for "${msg}":\n\n`;
      let found = false;
      
      Object.entries(reports).forEach(([key, report]) => {
        const searchText = `${report.item} ${report.location} ${report.description}`.toLowerCase();
        if (searchText.includes(msg.toLowerCase())) {
          found = true;
          response += `• ${report.item}\n`;
          response += `  Location: ${report.location}\n`;
          if (report.type === 'found') {
            response += `  Contact: ${report.contact_phone}\n`;
          }
          response += `  Status: ${report.type === 'lost' ? (report.recovered ? 'Recovered' : 'Not Recovered') : (report.claimed ? 'Claimed' : 'Not Claimed')}\n\n`;
        }
      });
      
      if (!found) {
        response = `❌ No items found matching "${msg}". Try different keywords.`;
      }
      
      twiml.message(response);
      await remove(ref(db, `users/${from}`));
    }
  } catch (error) {
    console.error('Handle response error:', error);
    twiml.message('❌ Error. Please try again.');
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
expressApp.listen(PORT, () => console.log('WhatsApp bot running!'));
