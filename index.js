const express = require('express');
const twilio = require('twilio');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, push, set, get, child, remove, update } = require('firebase/database');
const axios = require('axios');
require('dotenv').config();

// Initialize Firebase Client SDK (your original configuration)
const firebaseConfig = {
  databaseURL: process.env.FIREBASE_DATABASE_URL
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// Initialize Express
const expressApp = express();
expressApp.use(express.urlencoded({ extended: true }));

// NEW: Helper function to generate verification code
function generateVerificationCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Helper function to find matching found items (keeping your original logic)
async function findMatchingFoundItems(searchItem) {
  try {
    const reportsSnapshot = await get(child(ref(db), 'reports'));
    const reports = reportsSnapshot.val();
    
    if (!reports) return [];
    
    const searchKeywords = searchItem.toLowerCase().split(' ');
    const matchingItems = [];
    
    Object.entries(reports).forEach(([key, report]) => {
      // Only include found items in the search results
      if (report.type === 'found') {
        const reportText = `${report.item} ${report.description || ''}`.toLowerCase();
        const matchScore = searchKeywords.reduce((score, keyword) => {
          return score + (reportText.includes(keyword) ? 1 : 0);
        }, 0);
        
        // Bonus points for having an image
        if (report.image_url) {
          matchScore += 2;
        }
        
        if (matchScore > 0) {
          matchingItems.push({...report, matchScore});
        }
      }
    });
    
    return matchingItems.sort((a, b) => b.matchScore - a.matchScore);
  } catch (error) {
    console.error('Error finding matching items:', error);
    return [];
  }
}

// NEW: Helper function to show user's reports
async function showUserReports(from, twiml) {
  try {
    const reportsSnapshot = await get(child(ref(db), 'reports'));
    const reports = reportsSnapshot.val();
    
    if (!reports || Object.keys(reports).length === 0) {
      twiml.message('❌ You have not reported any items yet.\n\nUse the menu to report a lost or found item.');
      return;
    }
    
    let response = `📋 *Your Reports*\n\n`;
    let hasReports = false;
    
    Object.entries(reports).forEach(([key, report]) => {
      if (report.reporter === from) {
        hasReports = true;
        const date = new Date(report.timestamp).toLocaleString();
        
        if (report.type === 'lost') {
          const status = report.recovered ? '✅ Recovered' : '❌ Not Recovered';
          response += `🔍 *Lost Item: ${report.item}*\n`;
          response += `📍 Location: ${report.location}\n`;
          response += `📅 Reported: ${date}\n`;
          response += `📊 Status: ${status}\n`;
          response += `🔐 Code: ${report.verification_code}\n\n`;
        } else {
          const status = report.claimed ? '✅ Claimed' : '❌ Not Claimed';
          response += `🎁 *Found Item: ${report.item}*`;
          if (report.image_url) {
            response += ` 📷`;
          }
          response += `\n📍 Location: ${report.location}\n`;
          response += `📅 Reported: ${date}\n`;
          response += `📊 Status: ${status}\n`;
          response += `🔐 Code: ${report.verification_code}\n\n`;
        }
      }
    });
    
    if (!hasReports) {
      response = '❌ You have not reported any items yet.\n\nUse the menu to report a lost or found item.';
    } else {
      response += `💡 *To mark an item as claimed/recovered:*\n`;
      response += `Reply with: MARK [CODE] [STATUS]\n`;
      response += `Example: "MARK ABC123 CLAIMED" or "MARK XYZ789 RECOVERED"`;
    }
    
    twiml.message(response);
  } catch (error) {
    console.error('Show user reports error:', error);
    twiml.message('❌ An error occurred while fetching your reports. Please try again.');
  }
}

// NEW: Helper function to handle marking items as claimed/recovered
async function handleMarkItem(from, msg, twiml) {
  try {
    const parts = msg.trim().split(' ');
    
    if (parts.length < 3) {
      twiml.message('⚠️ Format error. Please use: MARK [CODE] [STATUS]\n\nExample: "MARK ABC123 CLAIMED" or "MARK XYZ789 RECOVERED"');
      return;
    }
    
    const code = parts[1].toUpperCase();
    const status = parts[2].toLowerCase();
    
    if (status !== 'claimed' && status !== 'recovered') {
      twiml.message('⚠️ Invalid status. Please use "CLAIMED" for found items or "RECOVERED" for lost items.');
      return;
    }
    
    // Find the report with this verification code
    const reportsSnapshot = await get(child(ref(db), 'reports'));
    const reports = reportsSnapshot.val();
    
    let targetReport = null;
    let reportId = null;
    
    Object.entries(reports).forEach(([key, report]) => {
      if (report.verification_code === code && report.reporter === from) {
        targetReport = report;
        reportId = key;
      }
    });
    
    if (!targetReport) {
      twiml.message('❌ Invalid verification code or you are not authorized to modify this report. Please check your code and try again.');
      return;
    }
    
    // Check if the status is appropriate for the report type
    if (targetReport.type === 'lost' && status !== 'recovered') {
      twiml.message('⚠️ Lost items can only be marked as "RECOVERED".');
      return;
    }
    
    if (targetReport.type === 'found' && status !== 'claimed') {
      twiml.message('⚠️ Found items can only be marked as "CLAIMED".');
      return;
    }
    
    // Check if already marked
    if ((targetReport.type === 'lost' && targetReport.recovered) || 
        (targetReport.type === 'found' && targetReport.claimed)) {
      twiml.message(`⚠️ This item has already been marked as ${status}.`);
      return;
    }
    
    // Update the report
    const updateData = {};
    if (status === 'claimed') {
      updateData.claimed = true;
      updateData.claimed_at = new Date().toISOString();
    } else {
      updateData.recovered = true;
      updateData.recovered_at = new Date().toISOString();
    }
    
    await update(ref(db, `reports/${reportId}`), updateData);
    
    // FIXED: Make sure the success message is sent
    const successMessage = `✅ Item Successfully Marked as ${status.charAt(0).toUpperCase() + status.slice(1)}!\n\nItem: ${targetReport.item}\nLocation: ${targetReport.location}\n\nThank you for using KWASU Lost & Found Bot!`;
    
    twiml.message(successMessage);
    console.log(`[DEBUG] Mark item success message sent: ${successMessage}`);
    
  } catch (error) {
    console.error('Handle mark item error:', error);
    twiml.message('❌ An error occurred. Please try again.');
  }
}

// Media message handler - RESTORED TO YOUR ORIGINAL VERSION
async function handleMediaMessage(req, twiml) {
  const from = req.body.From;
  const numMedia = parseInt(req.body.NumMedia);
  
  try {
    const userSnapshot = await get(child(ref(db), `users/${from}`));
    const user = userSnapshot.val();
    
    if (!user || user.action !== 'report_found' || user.step !== 'awaiting_image') {
      twiml.message('❌ Please start by selecting "Report Found Item" from the menu. Images are only required for found items.');
      return;
    }

    for (let i = 0; i < numMedia; i++) {
      const mediaUrl = req.body[`MediaUrl${i}`];
      const contentType = req.body[`MediaContentType${i}`];
      
      if (contentType && contentType.startsWith('image/')) {
        try {
          console.log(`Downloading image from: ${mediaUrl}`);
          
          const response = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            auth: {
              username: process.env.TWILIO_ACCOUNT_SID,
              password: process.env.TWILIO_AUTH_TOKEN
            },
            timeout: 20000 // 20 second timeout
          });

          // Check if we received any data
          if (!response.data || response.data.length === 0) {
            throw new Error("Received empty file from Twilio.");
          }
          
          console.log(`Image downloaded successfully. Size: ${response.data.length} bytes.`);

          // Use the standard, more reliable buffer-to-base64 conversion
          const base64Image = Buffer.from(response.data).toString('base64');
          const imageUrl = `data:${contentType};base64,${base64Image}`;
          
          console.log(`Image converted to base64. Length: ${imageUrl.length}`);

          // Update user state with the image
          await set(ref(db, `users/${from}`), {
            action: 'report_found',
            step: 'awaiting_details',
            image_url: imageUrl
          });
          
          twiml.message(`✅ Image received! Now, please provide the item details in this format:\n\nITEM, LOCATION, CONTACT_PHONE\n\nExample: "Keys, Cafeteria, 08012345678"`);
          return;

        } catch (imgError) {
          console.error('Error processing image:', imgError.message);
          
          // Provide a more specific error message to the user based on the error type
          let userMessage = '❌ Error processing image. Please try again.';
          if (imgError.code === 'ECONNABORTED') {
            userMessage = '❌ The image download timed out. Please try sending a smaller image or check your connection.';
          } else if (imgError.response && imgError.response.status === 404) {
            userMessage = '❌ The image link was invalid. Please try sending the image again.';
          }
          
          twiml.message(userMessage);
          return;
        }
      }
    }

    twiml.message('❌ No valid images received. Please send an image of the found item to continue.');

  } catch (error) {
    console.error('FATAL ERROR in handleMediaMessage:', error);
    twiml.message('❌ An unexpected server error occurred. Please try again later.');
  }
}

// Response handler - MINIMAL CHANGES TO ADD VERIFICATION CODE
async function handleResponse(from, msg, twiml) {
  try {
    console.log(`[DEBUG] handleResponse called for user ${from} with message: ${msg}`);
    
    const userSnapshot = await get(child(ref(db), `users/${from}`));
    const user = userSnapshot.val();
    
    console.log(`[DEBUG] User state: ${JSON.stringify(user)}`);
    
    if (!user) {
      console.log(`[DEBUG] No user state found for ${from}`);
      twiml.message('❓ Invalid command. Reply "menu" for options.');
      return;
    }

    // Handle LOST ITEM report (no image needed)
    if (user.action === 'report_lost') {
      console.log(`[DEBUG] Processing lost item report`);
      
      const parts = msg.split(',');
      if (parts.length < 3) {
        twiml.message('⚠️ Format error. Please use: ITEM, LOCATION, DESCRIPTION\n\nExample: "Water Bottle, Library, Blue with sticker"');
        return;
      }
      
      // Preserve original case for user input
      const item = parts[0].trim();
      const location = parts[1].trim();
      const description = parts.slice(2).join(',').trim();
      
      // NEW: Generate verification code
      const verificationCode = generateVerificationCode();
      
      const reportData = {
        type: 'lost',
        item,
        location,
        description,
        reporter: from,
        timestamp: new Date().toISOString(),
        // NEW: Add verification code and status
        verification_code: verificationCode,
        recovered: false
      };
      
      console.log(`[DEBUG] Saving lost item report: ${JSON.stringify(reportData)}`);
      
      const newReportRef = push(ref(db, 'reports'));
      await set(newReportRef, reportData);

      let confirmationMsg = `✅ *Lost Item Reported Successfully!*\n\n`;
      confirmationMsg += `📦 *Item:* ${item}\n`;
      confirmationMsg += `📍 *Location:* ${location}\n`;
      confirmationMsg += `📝 *Description:* ${description}\n`;
      // NEW: Add verification code to confirmation
      confirmationMsg += `🔐 *Verification Code:* ${verificationCode}\n\n`;
      confirmationMsg += `🔍 *We're searching for matching found items...*\n\n`;
      
      // Search for matching found items (case-insensitive)
      const foundItems = await findMatchingFoundItems(item);
      if (foundItems.length > 0) {
        confirmationMsg += `🎉 *Good news!* We found ${foundItems.length} matching item(s):\n\n`;
        foundItems.forEach((foundItem, index) => {
          confirmationMsg += `${index + 1}. *${foundItem.item}*\n`;
          confirmationMsg += `   📍 Location: ${foundItem.location}\n`;
          confirmationMsg += `   📞 Contact: ${foundItem.contact_phone}\n`;
          confirmationMsg += `   📝 ${foundItem.description}\n`;
          if (foundItem.image_url) {
            // FIXED: Added the requested text in front of "Has image"
            confirmationMsg += `   📷 (Go to finditkwasu.ng to see the image result) Has image\n`;
          }
          confirmationMsg += `   ⏰ ${new Date(foundItem.timestamp).toLocaleString()}\n\n`;
        });
        
        confirmationMsg += `💡 *Tip:* When contacting, please provide details about your lost item to verify ownership.\n\n`;
      } else {
        confirmationMsg += `😔 *No matching found items yet.*\n\n`;
        confirmationMsg += `💡 *What to do next:*\n`;
        confirmationMsg += `• Check back regularly for updates\n`;
        confirmationMsg += `• Spread the word about your lost item\n`;
        confirmationMsg += `• Contact locations where you might have lost it\n\n`;
      }
      
      // NEW: Add reminder about verification code
      confirmationMsg += `💡 *Save your verification code!*\n`;
      confirmationMsg += `You'll need it to mark this item as recovered later.\n\n`;
      confirmationMsg += `🙏 *Thank you for using KWASU Lost & Found Bot!*`;
      
      console.log(`[DEBUG] Sending lost item confirmation message`);
      twiml.message(confirmationMsg);
      
      await remove(ref(db, `users/${from}`));
    }
    
    // Handle FOUND ITEM report (image is compulsory)
    else if (user.action === 'report_found') {
      console.log(`[DEBUG] Processing found item report`);
      
      // Check if user is trying to send text before an image
      if (user.step === 'awaiting_image') {
        twiml.message('⚠️ An image is required for found items. Please send an image of the item first.');
        return;
      }

      // User is sending details after the image
      if (user.step === 'awaiting_details') {
        // IMPORTANT: Check if the image was actually saved
        if (!user.image_url) {
          console.error(`Image data missing for user ${from} during found item report.`);
          twiml.message('❌ An error occurred. The image was not saved correctly. Please start over by replying "menu".');
          await remove(ref(db, `users/${from}`)); // Reset user state
          return;
        }

        const parts = msg.split(',');
        if (parts.length < 3) {
          twiml.message('⚠️ Format error. Please use: ITEM, LOCATION, CONTACT_PHONE\n\nExample: "Keys, Cafeteria, 08012345678"');
          return;
        }
        
        // Preserve original case for user input
        const item = parts[0].trim();
        const location = parts[1].trim();
        const contact_phone = parts[2].trim();
        const description = parts.slice(3).join(',').trim() || 'No description';
        
        // NEW: Generate verification code
        const verificationCode = generateVerificationCode();
        
        const reportData = {
          type: 'found',
          item,
          location,
          contact_phone,
          description,
          image_url: user.image_url, // Get the image from the user's state
          reporter: from,
          timestamp: new Date().toISOString(),
          // NEW: Add verification code and status
          verification_code: verificationCode,
          claimed: false
        };
        
        console.log(`[DEBUG] Saving found item report: ${JSON.stringify(reportData)}`);
        
        const newReportRef = push(ref(db, 'reports'));
        await set(newReportRef, reportData);

        let confirmationMsg = `✅ *Found Item Reported Successfully!*\n\n`;
        confirmationMsg += `📦 *Item:* ${item}\n`;
        confirmationMsg += `📍 *Location:* ${location}\n`;
        confirmationMsg += `📞 *Contact:* ${contact_phone}\n`;
        confirmationMsg += `📝 *Description:* ${description}\n`;
        confirmationMsg += `📷 *Image:* Attached\n`;
        // NEW: Add verification code to confirmation
        confirmationMsg += `🔐 *Verification Code:* ${verificationCode}\n\n`;
        
        // FIXED: Added the minimal safety format
        confirmationMsg += `⚠️ *SAFETY NOTICE:*\n`;
        confirmationMsg += `If someone contacts you to claim this item, please:\n\n`;
        confirmationMsg += `🔐 *Ask for key details:*\n`;
        confirmationMsg += `• Color or size\n`;
        confirmationMsg += `• Unique marks or scratches\n`;
        confirmationMsg += `• Contents (if any)\n\n`;
        confirmationMsg += `🚫 *If details are wrong:*\n`;
        confirmationMsg += `• *Don't release the item*\n`;
        confirmationMsg += `• *Contact KWASU WORKS*\n`;
        confirmationMsg += `• *Share the person's phone number*\n\n`;
        confirmationMsg += `🛡️ *This keeps our community safe.*\n\n`;
        // NEW: Add reminder about verification code
        confirmationMsg += `💡 *Save your verification code!*\n`;
        confirmationMsg += `You'll need it to mark this item as claimed later.\n\n`;
        confirmationMsg += `🙏 *Thank you for your honesty!*`;
        
        console.log(`[DEBUG] Sending found item confirmation message`);
        twiml.message(confirmationMsg);
        
        await remove(ref(db, `users/${from}`));
      }
    }
    
    // Handle search - only show found items
    else if (user.action === 'search') {
      console.log(`[DEBUG] Processing search for: ${msg}`);
      
      const reportsSnapshot = await get(child(ref(db), 'reports'));
      const reports = reportsSnapshot.val();
      
      if (!reports || Object.keys(reports).length === 0) {
        twiml.message('❌ No items found in the database.');
        return;
      }

      let response = `🔎 *Search Results*\n\nFound items matching "${msg}":\n\n`;
      let found = false;
      
      Object.entries(reports).forEach(([key, report]) => {
        // Only include found items in search results
        if (report.type === 'found') {
          const searchText = `${report.item} ${report.location} ${report.description || ''}`.toLowerCase();
          if (searchText.includes(msg.toLowerCase())) {
            found = true;
            response += `📦 *${report.item}*`;
            if (report.image_url) {
              // FIXED: Added the requested text in front of "Has image"
              response += ` 📷 (Go to finditkwasu.ng to see the image result) Has image`;
            }
            response += `\n📍 Location: ${report.location}\n`;
            response += `📝 ${report.description || 'No description'}`;
            response += `\n📞 Contact: ${report.contact_phone}`;
            response += `\n⏰ ${new Date(report.timestamp).toLocaleString()}\n\n`;
          }
        }
      });
      
      if (!found) {
        response = `❌ No found items matching "${msg}".\n\nTry searching with different keywords or check the spelling.`;
      }
      
      console.log(`[DEBUG] Sending search results`);
      twiml.message(response);
      await remove(ref(db, `users/${from}`));
    }
  } catch (error) {
    console.error('Handle response error:', error);
    twiml.message('❌ An error occurred. Please try again.');
  }
}

// Main WhatsApp webhook handler - MINIMAL CHANGES TO ADD NEW MENU OPTIONS
expressApp.post('/whatsapp', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const msg = req.body.Body ? req.body.Body.toLowerCase().trim() : '';
  const originalMsg = req.body.Body ? req.body.Body.trim() : ''; // Keep original case for certain operations
  const from = req.body.From;
  const numMedia = parseInt(req.body.NumMedia) || 0;

  console.log(`[DEBUG] Received message from ${from}: "${msg}" (Media: ${numMedia})`);

  try {
    // Handle media messages
    if (numMedia > 0) {
      console.log(`[DEBUG] Processing media message`);
      await handleMediaMessage(req, twiml);
      res.type('text/xml').send(twiml.toString());
      return;
    }

    // Main menu - UPDATED TO INCLUDE NEW OPTIONS
    if (msg === 'menu') {
      console.log(`[DEBUG] Showing main menu`);
      twiml.message(`📋 *Welcome to Kwasu Lost And Found Bot!*\n_v0.2 with Image Support - Designed & Developed by_ Rugged of ICT.\n\nTo proceed with, Select what you are here for from the menu:\n\n1. *Report Lost Item*\n2. *Report Found Item*\n3. *Search for my lost Item*\n4. *My Reports*\n5. *Mark Item as Claimed/Recovered*\n\nKindly Reply with 1, 2, 3, 4, or 5.`);
    } 
    // Report lost
    else if (msg === '1') {
      console.log(`[DEBUG] User selected option 1 - Report Lost Item`);
      
      // Clear any existing user state first
      await remove(ref(db, `users/${from}`));
      
      // Set new user state
      await set(ref(db, `users/${from}`), { 
        action: 'report_lost'
      });
      
      console.log(`[DEBUG] Set user state for ${from} to report_lost`);
      
      // Send the instruction message
      const instructionMsg = '🔍 *Report Lost Item*\n\nPlease provide the following details:\nITEM, LOCATION, DESCRIPTION\n\nExample: "Water Bottle, Library, Blue with sticker"';
      twiml.message(instructionMsg);
      console.log(`[DEBUG] Sent instruction message for lost item report`);
    }
    // Report found
    else if (msg === '2') {
      console.log(`[DEBUG] User selected option 2 - Report Found Item`);
      
      // Clear any existing user state first
      await remove(ref(db, `users/${from}`));
      
      // Set new user state
      await set(ref(db, `users/${from}`), { 
        action: 'report_found',
        step: 'awaiting_image'
      });
      
      console.log(`[DEBUG] Set user state for ${from} to report_found`);
      
      // Send the instruction message
      const instructionMsg = '🎁 *Report Found Item*\n\n📷 *Step 1:* Please send an image of the found item.\n\nAfter the image is received, you will be asked for the details.';
      twiml.message(instructionMsg);
      console.log(`[DEBUG] Sent instruction message for found item report`);
    }
    // Search
    else if (msg === '3') {
      console.log(`[DEBUG] User selected option 3 - Search`);
      twiml.message('🔎 *Search for my lost Item*\n\nPlease reply with a keyword to search:\n\nExample: "water", "keys", "bag"\n\n💡 *Tip:* Items with images are marked with 📷');
      await set(ref(db, `users/${from}`), { action: 'search' });
    }
    // NEW: My reports
    else if (msg === '4') {
      console.log(`[DEBUG] User selected option 4 - My Reports`);
      await showUserReports(from, twiml);
    }
    // NEW: Mark item
    else if (msg === '5') {
      console.log(`[DEBUG] User selected option 5 - Mark Item`);
      twiml.message('📝 *Mark Item as Claimed/Recovered*\n\nTo mark an item, reply with:\n\nMARK [CODE] [STATUS]\n\nExamples:\n• "MARK ABC123 CLAIMED" (for found items)\n• "MARK XYZ789 RECOVERED" (for lost items)\n\n💡 You can find your verification codes in option 4 (My Reports)');
    }
    // Cancel option
    else if (msg === 'cancel' || msg === '0') {
      console.log(`[DEBUG] User selected cancel`);
      twiml.message('❌ Operation cancelled. Reply "menu" to start again.');
      await remove(ref(db, `users/${from}`));
    }
    // NEW: Handle MARK commands
    else if (msg.startsWith('mark ')) {
      console.log(`[DEBUG] Processing MARK command: ${msg}`);
      await handleMarkItem(from, originalMsg, twiml);
    }
    // Handle responses
    else {
      console.log(`[DEBUG] Handling user response: ${msg}`);
      await handleResponse(from, originalMsg, twiml); // Pass the original message with case preserved
    }

    console.log(`[DEBUG] Sending TwiML response`);
    res.type('text/xml').send(twiml.toString());
  } catch (error) {
    console.error('Main handler error:', error);
    twiml.message('❌ An error occurred. Please try again.');
    res.type('text/xml').send(twiml.toString());
  }
});

// Health check endpoint
expressApp.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Add this to your server files (after the existing routes)
expressApp.get('/keep-alive', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'KWASU Lost & Found Bot'
  });
});

// Clean up expired user states (runs every 5 minutes)
async function cleanupExpiredStates() {
  try {
    const usersRef = ref(db, 'users');
    const snapshot = await get(usersRef);
    const users = snapshot.val() || {};
    
    const now = Date.now();
    const timeout = 10 * 60 * 1000; // 10 minutes
    
    Object.entries(users).forEach(async ([user, data]) => {
      if (data.timestamp && (now - new Date(data.timestamp).getTime() > timeout)) {
        await remove(ref(db, `users/${user}`));
      }
    });
  } catch (error) {
    console.error('Error cleaning up expired states:', error);
  }
}

setInterval(cleanupExpiredStates, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
expressApp.listen(PORT, () => {
  console.log(`🚀 Kwasu Lost And Found Bot running on port ${PORT}`);
  console.log(`📱 WhatsApp webhook: /whatsapp`);
  console.log(`💚 Health check: /health`);
});
