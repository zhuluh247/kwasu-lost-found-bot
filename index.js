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

// Recovery tips
const RECOVERY_TIPS = [
  "Always check with lost & found offices first",
  "Retrace your steps from the last place you remember having the item",
  "Ask friends and classmates if they've seen your item",
  "Check social media groups for lost & found posts",
  "For valuable items, consider reporting to campus security",
  "Label your belongings with your name and contact",
  "Keep a record of important item serial numbers",
  "Use tracking apps for phones and other electronics"
];

// Handle WhatsApp messages
expressApp.post('/whatsapp', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const msg = req.body.Body.toLowerCase().trim();
  const from = req.body.From;

  try {
    // Quick actions
    if (msg === 'help') {
      twiml.message(getHelpMessage());
    } else if (msg === 'about') {
      twiml.message(getAboutMessage());
    } else if (msg === 'contact') {
      twiml.message(getContactMessage());
    } else if (msg === 'stories') {
      twiml.message(await getSuccessStories());
    } else if (msg === 'tips') {
      twiml.message(getRecoveryTips());
    }
    // Main menu
    else if (msg === 'menu') {
      twiml.message(`📋 *Welcome to Kwasu Lost And Found Bot!*\n_v0.1 Designed & Developed by_ Rugged of ICT.\n\nTo proceed with, Select what you are here for from the menu:\n\n1. *Report Lost Item*\n2. *Report Found Item*\n3. *Search for my lost Item*\n4. *Update Report Status*\n\nQuick Actions: help, about, contact, stories, tips\n\nKindly Reply with 1, 2, 3, or 4.`);
    } 
    // Report lost
    else if (msg === '1') {
      twiml.message('🔍 *Report Lost Item*\n\nPlease provide: ITEM, LOCATION, DESCRIPTION\n\nExample: "iPhone 13, Library, Black with blue case"');
      await set(ref(db, `users/${from}`), { action: 'report_lost_details' });
    }
    // Report found
    else if (msg === '2') {
      twiml.message('🎁 *Report Found Item*\n\nPlease provide: ITEM, LOCATION, CONTACT_PHONE\n\nExample: "Keys, Cafeteria, 08012345678"');
      await set(ref(db, `users/${from}`), { action: 'report_found_details' });
    }
    // Search
    else if (msg === '3') {
      twiml.message('🔎 *Search for my lost Item*\n\nPlease reply with a keyword to search:\n\nExample: "phone", "keys", "id card"');
      await set(ref(db, `users/${from}`), { action: 'search' });
    }
    // Update status
    else if (msg === '4') {
      twiml.message('📝 *Update Report Status*\n\nTo mark an item as claimed/recovered:\n\n1. I found my item (lost item owner)\n2. Item was claimed (found item owner)\n\nReply with 1 or 2');
      await set(ref(db, `users/${from}`), { action: 'update_status' });
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
    const userSnapshot = await get(child(ref(db, `users/${from}`));
    const user = userSnapshot.val();
    
    if (!user) {
      twiml.message('❓ Invalid command. Reply "menu" for options.');
      return;
    }

    // Handle status update
    if (user.action === 'update_status') {
      if (msg === '1' || msg === '2') {
        twiml.message(`📝 *To update status, please provide:*\n\nREPORT_ID or ITEM_NAME\n\nExample: "iPhone 13" or "keys"`);
        await set(ref(db, `users/${from}`), { 
          action: 'confirm_status_update', 
          status_type: msg === '1' ? 'recovered' : 'claimed' 
        });
      } else {
        twiml.message('⚠️ Invalid option. Reply with 1 or 2');
      }
      return;
    }

    // Handle status confirmation
    if (user.action === 'confirm_status_update') {
      const reportsSnapshot = await get(child(ref(db, 'reports'));
      const reports = reportsSnapshot.val();
      
      if (!reports) {
        twiml.message('❌ No reports found in database.');
        await remove(ref(db, `users/${from}`));
        return;
      }

      let foundReport = null;
      for (const [key, report] of Object.entries(reports)) {
        if ((report.reporter === from || report.contact_phone === from) && 
            (report.item.toLowerCase().includes(msg.toLowerCase()) || key === msg)) {
          foundReport = { key, ...report };
          break;
        }
      }

      if (foundReport) {
        await update(ref(db, `reports/${foundReport.key}`), {
          status: user.status_type,
          updated_at: new Date().toISOString()
        });

        // Add to success stories
        await push(ref(db, 'success_stories'), {
          item: foundReport.item,
          type: foundReport.type,
          status: user.status_type,
          timestamp: new Date().toISOString()
        });

        twiml.message(`✅ *Report Updated Successfully!*\n\nItem: ${foundReport.item}\nStatus: ${user.status_type === 'recovered' ? 'Recovered' : 'Claimed'}\n\n🎉 Thank you for updating the status! Your success story inspires others.`);
      } else {
        twiml.message('❌ No matching report found. Please check the item name or report ID.');
      }
      
      await remove(ref(db, `users/${from}`));
      return;
    }

    // Handle report submission
    if (user.action === 'report_lost_details' || user.action === 'report_found_details') {
      const parts = msg.split(',');
      if (parts.length < 3) {
        twiml.message(`⚠️ Format error. Please use: ITEM, LOCATION, ${user.action === 'report_lost_details' ? 'DESCRIPTION' : 'CONTACT_PHONE'}`);
        return;
      }
      
      const item = parts[0].trim();
      const location = parts[1].trim();
      const thirdPart = parts[2].trim();
      
      let reportData = {
        type: user.action.includes('lost') ? 'lost' : 'found',
        item,
        location,
        reporter: from,
        timestamp: new Date().toISOString(),
        status: 'active'
      };
      
      if (user.action === 'report_lost_details') {
        reportData.description = parts.slice(2).join(',').trim();
      } else {
        reportData.contact_phone = thirdPart;
        reportData.description = parts.slice(3).join(',').trim() || 'No description';
      }
      
      // Save to Firebase
      const newReportRef = push(ref(db, 'reports'));
      await set(newReportRef, reportData);

      // Send confirmation
      let confirmationMsg = `✅ *${user.action.includes('lost') ? 'Lost' : 'Found'} Item Reported Successfully!*\n\n`;
      confirmationMsg += `📦 *Item:* ${item}\n`;
      confirmationMsg += `📍 *Location:* ${location}\n`;
      if (user.action === 'report_lost_details') {
        confirmationMsg += `📝 *Description:* ${reportData.description}\n\n`;
        confirmationMsg += `🔍 *We're searching for matching found items...*\n\n`;
        
        const foundItems = await findMatchingFoundItems(item);
        if (foundItems.length > 0) {
          confirmationMsg += `🎉 *Good news!* We found ${foundItems.length} matching item(s):\n\n`;
          foundItems.forEach((item, index) => {
            confirmationMsg += `${index + 1}. *${item.item}*\n`;
            confirmationMsg += `   📍 Location: ${item.location}\n`;
            confirmationMsg += `   📞 Contact: ${item.contact_phone}\n`;
            confirmationMsg += `   📝 ${item.description}\n`;
            confirmationMsg += `   ⏰ ${new Date(item.timestamp).toLocaleString()}\n\n`;
          });
        } else {
          confirmationMsg += `😔 *No matching found items yet.*\n\n`;
          confirmationMsg += `💡 *Tip:* Reply "tips" for recovery advice\n`;
        }
      } else {
        confirmationMsg += `📞 *Contact:* ${reportData.contact_phone}\n`;
        confirmationMsg += `📝 *Description:* ${reportData.description}\n\n`;
        confirmationMsg += `⚠️ *Remember to ask claimants for proof of ownership before returning items!*`;
      }
      
      twiml.message(confirmationMsg);
      await remove(ref(db, `users/${from}`));
    }
    
    // Handle search
    else if (user.action === 'search') {
      const reportsSnapshot = await get(child(ref(db, 'reports'));
      const reports = reportsSnapshot.val();
      
      if (!reports || Object.keys(reports).length === 0) {
        twiml.message('❌ No items found in the database.');
        await remove(ref(db, `users/${from}`));
        return;
      }

      let response = `🔎 *Search Results*\n\nFound items matching "${msg}":\n\n`;
      let found = false;
      
      Object.entries(reports).forEach(([key, report]) => {
        if (report.status === 'active') {
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
        }
      });
      
      if (!found) {
        response = `❌ No active items found matching "${msg}".\n\nTry searching with different keywords or check the spelling.\n\n💡 *Reply "tips" for recovery advice.*`;
      }
      
      twiml.message(response);
      await remove(ref(db, `users/${from}`));
    }
  } catch (error) {
    console.error('Handle response error:', error);
    twiml.message('❌ An error occurred. Please try again.');
  }
}

// Helper functions
function getHelpMessage() {
  return `📚 *KWASU Lost & Found Bot - Help*\n\n*Available Commands:*\n\n• *menu* - Show main menu\n• *help* - Show this help message\n• *about* - About this bot\n• *contact* - Contact information\n• *stories* - Success stories\n• *tips* - Recovery tips\n\n*How to use:*\n1. Report lost items with details\n2. Report found items with contact info\n3. Search for lost items\n4. Update status when items are found/claimed\n\n*Tips:*\n• Update status when items are recovered\n• Ask claimants for proof of ownership`;
}

function getAboutMessage() {
  return `ℹ️ *About KWASU Lost And Found Bot*\n\n*Version:* v0.1\n*Designed & Developed by:* MUHAMMED ZULU AKINKUNMI (Popularly known as Rugged)\n\n*Developer Profile:*\n• ICT Student, Computer Science Precisely\n• Kwara State University (KWASU)\n• Passionate about innovative solutions\n\n*Purpose:* Helping KWASU students recover lost items\n\n*Features:*\n• Real-time lost & found reporting\n• Automatic matching system\n• Success stories sharing\n• Recovery tips and guidance\n• Campus-wide search\n\n*Mission:* To create a safer, more connected campus community by helping KWASU students recover their lost belongings quickly and efficiently.\n\n*Note:* This bot is exclusively for KWASU students.\n\n*Thank you for using this service!*`;
}

function getContactMessage() {
  return `📞 *Contact Information*\n\n*For Support or Issues:*\n\n• *WhatsApp:* 09038323588\n• *Email:* support@kwasu.edu.ng\n• *Office:* Student Affairs Building, Room 101\n\n*For False Claims or Issues:*\nContact KWASU WORKS immediately with the claimant's details.\n\n*Bot Developer:* MUHAMMED ZULU AKINKUNMI (Rugged)\n• WhatsApp: 09038323588\n• Department: Computer Science, KWASU\n\n*⚠️ Important Note:* When contacting the developer on WhatsApp, please go straight to the point in your DM to avoid late response. Be direct and clear about your issue or inquiry.\n\n*We're here to help!*`;
}

async function getSuccessStories() {
  try {
    const storiesSnapshot = await get(child(ref(db, 'success_stories'));
    const stories = storiesSnapshot.val();
    
    if (!stories) {
      return '🏆 *Success Stories*\n\nNo success stories yet. Be the first to recover a lost item and inspire others!';
    }
    
    let message = `🏆 *Recent Success Stories*\n\n`;
    
    Object.values(stories)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 5)
      .forEach((story, index) => {
        const timeAgo = getTimeAgo(new Date(story.timestamp));
        message += `${index + 1}. *${story.item}* (${story.type})\n`;
        message += `   Status: ${story.status === 'recovered' ? 'Recovered by owner' : 'Claimed by finder'}\n`;
        message += `   ${timeAgo}\n\n`;
      });
    
    message += `💫 *Your success story could be next!*\n\nKeep reporting and updating status to help others.`;
    return message;
  } catch (error) {
    console.error('Stories error:', error);
    return '❌ Error loading success stories. Please try again later.';
  }
}

function getRecoveryTips() {
  let message = `💡 *Recovery Tips*\n\n`;
  
  RECOVERY_TIPS.forEach((tip, index) => {
    message += `${index + 1}. ${tip}\n\n`;
  });
  
  message += `🍀 *Good luck recovering your items!*`;
  return message;
}

async function findMatchingFoundItems(searchItem) {
  try {
    const reportsSnapshot = await get(child(ref(db, 'reports'));
    const reports = reportsSnapshot.val();
    
    if (!reports) return [];
    
    const searchKeywords = searchItem.toLowerCase().split(' ');
    const matchingItems = [];
    
    Object.entries(reports).forEach(([key, report]) => {
      if (report.type === 'found' && report.status === 'active') {
        const reportText = `${report.item} ${report.description}`.toLowerCase();
        const matchScore = searchKeywords.reduce((score, keyword) => {
          return score + (reportText.includes(keyword) ? 1 : 0);
        }, 0);
        
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

function getTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  
  let interval = Math.floor(seconds / 31536000);
  if (interval >= 1) return interval + " year" + (interval > 1 ? "s" : "") + " ago";
  
  interval = Math.floor(seconds / 2592000);
  if (interval >= 1) return interval + " month" + (interval > 1 ? "s" : "") + " ago";
  
  interval = Math.floor(seconds / 86400);
  if (interval >= 1) return interval + " day" + (interval > 1 ? "s" : "") + " ago";
  
  interval = Math.floor(seconds / 3600);
  if (interval >= 1) return interval + " hour" + (interval > 1 ? "s" : "") + " ago";
  
  interval = Math.floor(seconds / 60);
  if (interval >= 1) return interval + " minute" + (interval > 1 ? "s" : "") + " ago";
  
  return "Just now";
}

const PORT = process.env.PORT || 3000;
expressApp.listen(PORT, () => console.log('Kwasu Lost And Found Bot running!'));
