const express = require('express');
const twilio = require('twilio');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, push, set, get, child, remove, update } = require('firebase/database');
const axios = require('axios');
require('dotenv').config();

// Initialize Firebase Client SDK
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

// SIMPLIFIED: Only find exact item name matches (case-insensitive)
async function findMatchingFoundItems(searchItem) {
  try {
    console.log(`[DEBUG] Searching for exact matches of: "${searchItem}"`);
    
    const reportsSnapshot = await get(child(ref(db), 'reports'));
    const reports = reportsSnapshot.val();
    
    if (!reports) {
      console.log('[DEBUG] No reports found in database');
      return [];
    }
    
    const searchItemLower = searchItem.toLowerCase().trim();
    const matchingItems = [];
    
    Object.entries(reports).forEach(([key, report]) => {
      // Only include found items in the search results
      if (report.type === 'found') {
        const reportItem = (report.item || '').toLowerCase().trim();
        
        console.log(`[DEBUG] Checking found item: "${report.item}" (type: ${report.type})`);
        
        // Only match if the item name is exactly the same (case-insensitive)
        if (reportItem === searchItemLower) {
          console.log(`[DEBUG] Exact match found: "${report.item}"`);
          matchingItems.push({...report, id: key});
        }
      }
    });
    
    console.log(`[DEBUG] Found ${matchingItems.length} exact matches`);
    return matchingItems;
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
    
    const successMessage = `✅ Item Successfully Marked as ${status.charAt(0).toUpperCase() + status.slice(1)}!\n\nItem: ${targetReport.item}\nLocation: ${targetReport.location}\n\nThank you for using KWASU Lost & Found Bot!`;
    
    twiml.message(successMessage);
    
  } catch (error) {
    console.error('Handle mark item error:', error);
    twiml.message('❌ An error occurred. Please try again.');
  }
}

// Media message handler - NOW ONLY FOR FOUND ITEMS (ROBUST VERSION)
async function handleMediaMessage(req, twiml) {
  const from = req.body.From;
  const numMedia = parseInt(req.body.NumMedia);
  
  try {
    const userSnapshot = await get(child(ref(db, `users/${from}`)));
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

// Response handler
async function handleResponse(from, msg, twiml) {
  try {
    // FIXED: Added missing closing parenthesis
    const userSnapshot = await get(child(ref(db, `users/${from}`)));
    const user = userSnapshot.val();
    
    if (!user) {
      twiml.message('❓ Invalid command. Reply "menu" for options.');
      return;
    }

    // Handle LOST ITEM report (no image needed)
    if (user.action === 'report_lost') {
      const parts = msg.split(',');
      if (parts.length < 3) {
        twiml.message('⚠️ Format error. Please use: ITEM, LOCATION, DESCRIPTION\n\nExample: "Water Bottle, Library, Blue with sticker"');
        return;
      }
      
      // Preserve original case for user input
      const item = parts[0].trim();
      const location = parts[1].trim();
      const description = parts.slice(2).join(',').trim();
      
      // Generate verification code
      const verificationCode = generateVerificationCode();
      
      const reportData = {
        type: 'lost',
        item,
        location,
        description,
        reporter: from,
        verification_code: verificationCode,
        recovered: false,
        timestamp: new Date().toISOString()
      };
      
      const newReportRef = push(ref(db, 'reports'));
      await set(newReportRef, reportData);

      let confirmationMsg = `✅ *Lost Item Reported Successfully!*\n\n`;
      confirmationMsg += `📦 *Item:* ${item}\n`;
      confirmationMsg += `📍 *Location:* ${location}\n`;
      confirmationMsg += `📝 *Description:* ${description}\n`;
      confirmationMsg += `🔐 *Verification Code:* ${verificationCode}\n\n`;
      confirmationMsg += `🔍 *We're searching for matching found items...*\n\n`;
      
      // Search for matching found items (case-insensitive)
      console.log(`[DEBUG] Searching for matches for lost item: "${item}"`);
      const foundItems = await findMatchingFoundItems(item);
      
      if (foundItems.length > 0) {
        confirmationMsg += `🎉 *Good news!* We found ${foundItems.length} matching item(s):\n\n`;
        foundItems.forEach((foundItem, index) => {
          confirmationMsg += `${index + 1}. *${foundItem.item}*\n`;
          confirmationMsg += `   📍 Location: ${foundItem.location}\n`;
          confirmationMsg += `   📞 Contact: ${foundItem.contact_phone}\n`;
          confirmationMsg += `   📝 ${foundItem.description}\n`;
          if (foundItem.image_url) {
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
      
      confirmationMsg += `💡 *Save your verification code!*\n`;
      confirmationMsg += `You'll need it to mark this item as recovered later.\n\n`;
      confirmationMsg += `🙏 *Thank you for using KWASU Lost & Found Bot!*`;
      
      // CRITICAL FIX: Make sure the message is sent
      twiml.message(confirmationMsg);
      console.log(`[DEBUG] Sending response message: ${confirmationMsg.substring(0, 50)}...`);
      
      await remove(ref(db, `users/${from}`));
    }
    
    // Handle FOUND ITEM report (image is compulsory)
    else if (user.action === 'report_found') {
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
        
        // Generate verification code
        const verificationCode = generateVerificationCode();
        
        const reportData = {
          type: 'found',
          item,
          location,
          contact_phone,
          description,
          image_url: user.image_url, // Get the image from the user's state
          reporter: from,
          verification_code: verificationCode,
          claimed: false,
          timestamp: new Date().toISOString()
        };
        
        const newReportRef = push(ref(db, 'reports'));
        await set(newReportRef, reportData);

        let confirmationMsg = `✅ *Found Item Reported Successfully!*\n\n`;
        confirmationMsg += `📦 *Item:* ${item}\n`;
        confirmationMsg += `📍 *Location:* ${location}\n`;
        confirmationMsg += `📞 *Contact:* ${contact_phone}\n`;
        confirmationMsg += `📝 *Description:* ${description}\n`;
        confirmationMsg += `📷 *Image:* Attached\n`;
        confirmationMsg += `🔐 *Verification Code:* ${verificationCode}\n\n`;
        
        // Updated safety notice with bold formatting
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
        confirmationMsg += `💡 *Save your verification code!*\n`;
        confirmationMsg += `You'll need it to mark this item as claimed later.\n\n`;
        confirmationMsg += `🙏 *Thank you for your honesty!*`;
        
        twiml.message(confirmationMsg);
        
        await remove(ref(db, `users/${from}`));
      }
    }
    
    // Handle search - only show exact matches for item names
    else if (user.action === 'search') {
      const reportsSnapshot = await get(child(ref(db), 'reports'));
      const reports = reportsSnapshot.val();
      
      if (!reports || Object.keys(reports).length === 0) {
        twiml.message('❌ No items found in the database.');
        return;
      }

      console.log(`[DEBUG] Manual search for exact matches of: "${msg}"`);
      let response = `🔎 *Search Results*\n\nFound items matching "${msg}":\n\n`;
      let found = false;
      
      Object.entries(reports).forEach(([key, report]) => {
        // Only include found items in search results
        if (report.type === 'found') {
          const reportItem = (report.item || '').toLowerCase().trim();
          const searchItem = msg.toLowerCase().trim();
          
          // Only match if the item name is exactly the same (case-insensitive)
          if (reportItem === searchItem) {
            found = true;
            response += `📦 *${report.item}*`;
            if (report.image_url) {
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
        response = `❌ No found items matching "${msg}".\n\nTry searching with the exact item name.`;
      }
      
      twiml.message(response);
      await remove(ref(db, `users/${from}`));
    }
  } catch (error) {
    console.error('Handle response error:', error);
    twiml.message('❌ An error occurred. Please try again.');
  }
}

// Main WhatsApp webhook handler
expressApp.post('/whatsapp', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const msg = req.body.Body ? req.body.Body.toLowerCase().trim() : '';
  const originalMsg = req.body.Body ? req.body.Body.trim() : ''; // Keep original case for certain operations
  const from = req.body.From;
  const numMedia = parseInt(req.body.NumMedia) || 0;

  try {
    // Handle media messages
    if (numMedia > 0) {
      await handleMediaMessage(req, twiml);
      res.type('text/xml').send(twiml.toString());
      return;
    }

    // Main menu
    if (msg === 'menu') {
      twiml.message(`📋 *Welcome to Kwasu Lost And Found Bot!*\n_v0.2 with Image Support - Designed & Developed by_ Rugged of ICT.\n\nTo proceed with, Select what you are here for from the menu:\n\n1. *Report Lost Item*\n2. *Report Found Item*\n3. *Search for my lost Item*\n4. *My Reports*\n5. *Mark Item as Claimed/Recovered*\n\nKindly Reply with 1, 2, 3, 4, or 5.`);
    } 
    // Report lost
    else if (msg === '1') {
      twiml.message('🔍 *Report Lost Item*\n\nPlease provide the following details:\nITEM, LOCATION, DESCRIPTION\n\nExample: "Water Bottle, Library, Blue with sticker"');
      await set(ref(db, `users/${from}`), { 
        action: 'report_lost'
      });
    }
    // Report found
    else if (msg === '2') {
      twiml.message('🎁 *Report Found Item*\n\n📷 *Step 1:* Please send an image of the found item.\n\nAfter the image is received, you will be asked for the details.');
      await set(ref(db, `users/${from}`), { 
        action: 'report_found',
        step: 'awaiting_image'
      });
    }
    // Search
    else if (msg === '3') {
      twiml.message('🔎 *Search for my lost Item*\n\nPlease reply with the exact item name to search:\n\nExample: "book", "keys", "bag"\n\n💡 *Tip:* Items with images are marked with 📷');
      await set(ref(db, `users/${from}`), { action: 'search' });
    }
    // My reports
    else if (msg === '4') {
      await showUserReports(from, twiml);
    }
    // Mark item
    else if (msg === '5') {
      twiml.message('📝 *Mark Item as Claimed/Recovered*\n\nTo mark an item, reply with:\n\nMARK [CODE] [STATUS]\n\nExamples:\n• "MARK ABC123 CLAIMED" (for found items)\n• "MARK XYZ789 RECOVERED" (for lost items)\n\n💡 You can find your verification codes in option 4 (My Reports)');
    }
    // Cancel option
    else if (msg === 'cancel' || msg === '0') {
      twiml.message('❌ Operation cancelled. Reply "menu" to start again.');
      await remove(ref(db, `users/${from}`));
    }
    // Handle MARK commands
    else if (msg.startsWith('mark ')) {
      await handleMarkItem(from, originalMsg, twiml);
    }
    // Handle responses
    else {
      await handleResponse(from, originalMsg, twiml); // Pass the original message with case preserved
    }

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

// DEBUG: Add endpoint to view all items for troubleshooting
expressApp.get('/debug/items', async (req, res) => {
  try {
    const reportsSnapshot = await get(child(ref(db), 'reports'));
    const reports = reportsSnapshot.val();
    
    const items = Object.entries(reports || {}).map(([key, report]) => ({
      id: key,
      type: report.type,
      item: report.item,
      location: report.location,
      hasImage: !!report.image_url,
      verificationCode: report.verification_code
    }));
    
    res.json(items);
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
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
  console.log(`🔍 Debug endpoint: /debug/items`);
});
