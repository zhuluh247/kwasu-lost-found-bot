const express = require('express');
const twilio = require('twilio');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, push, set, get, child, remove } = require('firebase/database');
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

// IMPROVED: Better matching function with more comprehensive search
async function findMatchingFoundItems(searchItem) {
  try {
    console.log(`[DEBUG] Searching for: "${searchItem}"`);
    
    const reportsSnapshot = await get(child(ref(db), 'reports'));
    const reports = reportsSnapshot.val();
    
    if (!reports) {
      console.log('[DEBUG] No reports found in database');
      return [];
    }
    
    const searchKeywords = searchItem.toLowerCase().split(' ').filter(k => k.length > 0);
    const matchingItems = [];
    
    console.log(`[DEBUG] Search keywords: ${searchKeywords.join(', ')}`);
    
    Object.entries(reports).forEach(([key, report]) => {
      // Only include found items in the search results
      if (report.type === 'found') {
        const reportItem = (report.item || '').toLowerCase().trim();
        const reportDescription = (report.description || '').toLowerCase().trim();
        const reportText = `${reportItem} ${reportDescription}`;
        
        console.log(`[DEBUG] Checking found item: "${report.item}" (type: ${report.type})`);
        
        let matchScore = 0;
        
        // PRIORITY 1: Exact item name match (highest priority)
        if (reportItem === searchItem.toLowerCase()) {
          matchScore = 100;
          console.log(`[DEBUG] Exact match found: "${report.item}"`);
        }
        // PRIORITY 2: Search item contains reported item or vice versa
        else if (reportItem.includes(searchItem.toLowerCase()) || searchItem.toLowerCase().includes(reportItem)) {
          matchScore = 80;
          console.log(`[DEBUG] Partial match found: "${report.item}"`);
        }
        // PRIORITY 3: Keyword matching
        else {
          searchKeywords.forEach(keyword => {
            if (keyword.length > 1) { // Skip single characters
              if (reportItem.includes(keyword)) {
                matchScore += 3; // Higher weight for item name matches
                console.log(`[DEBUG] Keyword "${keyword}" found in item name`);
              }
              if (reportDescription.includes(keyword)) {
                matchScore += 1; // Lower weight for description matches
                console.log(`[DEBUG] Keyword "${keyword}" found in description`);
              }
            }
          });
        }
        
        // Bonus points for having an image
        if (report.image_url) {
          matchScore += 2;
        }
        
        // Bonus points for recent reports (within last 7 days)
        const reportDate = new Date(report.timestamp);
        const now = new Date();
        const daysDiff = (now - reportDate) / (1000 * 60 * 60 * 24);
        if (daysDiff <= 7) {
          matchScore += 1;
        }
        
        if (matchScore > 0) {
          matchingItems.push({...report, matchScore, id: key});
          console.log(`[DEBUG] Added "${report.item}" with score ${matchScore}`);
        }
      }
    });
    
    const sortedMatches = matchingItems.sort((a, b) => b.matchScore - a.matchScore);
    console.log(`[DEBUG] Found ${sortedMatches.length} matching items`);
    
    return sortedMatches;
  } catch (error) {
    console.error('Error finding matching items:', error);
    return [];
  }
}

// Media message handler - NOW ONLY FOR FOUND ITEMS (ROBUST VERSION)
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

// Response handler
async function handleResponse(from, msg, twiml) {
  try {
    const userSnapshot = await get(child(ref(db), `users/${from}`));
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
      
      const reportData = {
        type: 'lost',
        item,
        location,
        description,
        reporter: from,
        timestamp: new Date().toISOString()
      };
      
      const newReportRef = push(ref(db, 'reports'));
      await set(newReportRef, reportData);

      let confirmationMsg = `✅ *Lost Item Reported Successfully!*\n\n`;
      confirmationMsg += `📦 *Item:* ${item}\n`;
      confirmationMsg += `📍 *Location:* ${location}\n`;
      confirmationMsg += `📝 *Description:* ${description}\n\n`;
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
            confirmationMsg += `   📷 Has image\n`;
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
      
      confirmationMsg += `🙏 *Thank you for using KWASU Lost & Found Bot!*`;
      twiml.message(confirmationMsg);
      
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
        
        const reportData = {
          type: 'found',
          item,
          location,
          contact_phone,
          description,
          image_url: user.image_url, // Get the image from the user's state
          reporter: from,
          timestamp: new Date().toISOString()
        };
        
        const newReportRef = push(ref(db, 'reports'));
        await set(newReportRef, reportData);

        let confirmationMsg = `✅ *Found Item Reported Successfully!*\n\n`;
        confirmationMsg += `📦 *Item:* ${item}\n`;
        confirmationMsg += `📍 *Location:* ${location}\n`;
        confirmationMsg += `📞 *Contact:* ${contact_phone}\n`;
        confirmationMsg += `📝 *Description:* ${description}\n`;
        confirmationMsg += `📷 *Image:* Attached\n\n`;
        
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
        confirmationMsg += `🛡️ *This keeps our community safe.*\n`;
        confirmationMsg += `🙏 *Thank you for your honesty!*`;
        
        twiml.message(confirmationMsg);
        
        await remove(ref(db, `users/${from}`));
      }
    }
    
    // Handle search - only show found items
    else if (user.action === 'search') {
      const reportsSnapshot = await get(child(ref(db), 'reports'));
      const reports = reportsSnapshot.val();
      
      if (!reports || Object.keys(reports).length === 0) {
        twiml.message('❌ No items found in the database.');
        return;
      }

      console.log(`[DEBUG] Manual search for: "${msg}"`);
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
              response += ` 📷`;
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
      twiml.message(`📋 *Welcome to Kwasu Lost And Found Bot!*\n_v0.2 with Image Support - Designed & Developed by_ Rugged of ICT.\n\nTo proceed with, Select what you are here for from the menu:\n\n1. *Report Lost Item*\n2. *Report Found Item*\n3. *Search for my lost Item*\n\nKindly Reply with 1, 2, or 3.`);
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
      twiml.message('🔎 *Search for my lost Item*\n\nPlease reply with a keyword to search:\n\nExample: "water", "keys", "bag"\n\n💡 *Tip:* Items with images are marked with 📷');
      await set(ref(db, `users/${from}`), { action: 'search' });
    }
    // Cancel option
    else if (msg === 'cancel' || msg === '0') {
      twiml.message('❌ Operation cancelled. Reply "menu" to start again.');
      await remove(ref(db, `users/${from}`));
    }
    // Handle responses
    else {
      await handleResponse(from, req.body.Body, twiml); // Pass the original message with case preserved
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
      hasImage: !!report.image_url
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
