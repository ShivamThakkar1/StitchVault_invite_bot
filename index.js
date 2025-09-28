require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

// Initialize Express for health checks
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('StitchVault Community Bot is running!');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const CHANNEL_ID = process.env.CHANNEL_ID;
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || 'stitchvault';
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id)) : [];
const INVITES_PER_REWARD = parseInt(process.env.INVITES_PER_REWARD) || 2;
const BOT_USERNAME = process.env.BOT_USERNAME || 'StitchVaultBot';
// Add configurable auto post interval (in hours)
const AUTO_POST_HOURS = parseInt(process.env.AUTO_POST_HOURS) || 48;

// Initialize bot
const bot = new TelegramBot(BOT_TOKEN, { 
  polling: {
    interval: 1000,
    autoStart: true,
    params: {
      timeout: 10,
      allowed_updates: ['message', 'callback_query', 'chat_member', 'my_chat_member', 'document', 'photo']
    }
  }
});

// Initialize bulk upload sessions
global.bulkUploadSessions = {};

// Welcome message cooldown to prevent spam
const welcomeCooldown = new Set();

// MongoDB connection
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    setupChatMemberUpdates();
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
  });

async function setupChatMemberUpdates() {
  try {
    console.log('Bot is set up to receive chat member updates');
    const botInfo = await bot.getMe();
    console.log(`Bot connected successfully: @${botInfo.username}`);
  } catch (error) {
    console.error('Error setting up chat member updates:', error);
  }
}

// User Schema
const userSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  username: String,
  firstName: String,
  lastName: String,
  referredBy: Number,
  referralCode: { type: String, unique: true },
  inviteCount: { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 },
  lastRewardLevel: { type: Number, default: 0 },
  joinedChannel: { type: Boolean, default: false },
  referralCounted: { type: Boolean, default: false },
  joinedAt: { type: Date, default: Date.now },
  lastActivity: { type: Date, default: Date.now },
  isBlocked: { type: Boolean, default: false },
  bonusReceived: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);

// Reward Schema
const rewardSchema = new mongoose.Schema({
  rewardId: { type: Number, required: true, unique: true },
  level: { type: Number, required: true },
  fileName: String,
  filePath: String,
  imageName: String,
  imagePath: String,
  description: String,
  addedBy: Number,
  addedAt: { type: Date, default: Date.now },
  isImageFile: { type: Boolean, default: false },
  originalOrder: Number
});

const Reward = mongoose.model('Reward', rewardSchema);

// Channel Post Schema
const channelPostSchema = new mongoose.Schema({
  postId: { type: String, required: true, unique: true },
  rewardLevel: Number,
  imageMessageId: Number,
  fileMessageId: Number,
  sentAt: { type: Date, default: Date.now },
  communityReferrals: { type: Number, default: 0 }
});

const ChannelPost = mongoose.model('ChannelPost', channelPostSchema);

// Stats Schema - now tracks total channel members instead of just referrals
const statsSchema = new mongoose.Schema({
  totalUsers: { type: Number, default: 0 },
  totalInvites: { type: Number, default: 0 },
  totalRewards: { type: Number, default: 0 },
  channelMembers: { type: Number, default: 0 },
  lastChannelPost: { type: Date, default: null },
  pendingReferrals: { type: Number, default: 0 },
  communityMemberCount: { type: Number, default: 0 }, // Changed from referral count to member count
  lastUpdated: { type: Date, default: Date.now }
});

const Stats = mongoose.model('Stats', statsSchema);

// Export models and bot for admin_features.js
global.bot = bot;
global.User = User;
global.Reward = Reward;
global.ChannelPost = ChannelPost;
global.Stats = Stats;

// Helper functions
function generateReferralCode(userId) {
  return `ref_${userId}_${Math.random().toString(36).substring(2, 8)}`;
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

// Export for admin_features.js
global.isAdmin = isAdmin;

async function updateUserActivity(userId) {
  await User.findOneAndUpdate(
    { userId },
    { lastActivity: new Date() }
  );
}

async function updateStats() {
  const totalUsers = await User.countDocuments();
  const totalInvites = await User.aggregate([
    { $group: { _id: null, total: { $sum: '$inviteCount' } } }
  ]);
  const totalRewards = await Reward.countDocuments();
  const channelMembers = await User.countDocuments({ joinedChannel: true });
  const pendingReferrals = await User.countDocuments({ 
    referredBy: { $exists: true }, 
    referralCounted: false 
  });
  
  await Stats.findOneAndUpdate(
    {},
    {
      totalUsers,
      totalInvites: totalInvites[0]?.total || 0,
      totalRewards,
      channelMembers,
      pendingReferrals,
      communityMemberCount: channelMembers, // Update member count
      lastUpdated: new Date()
    },
    { upsert: true }
  );
}

async function checkChannelMembership(userId) {
  try {
    const member = await bot.getChatMember(CHANNEL_ID, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (error) {
    return false;
  }
}

async function checkUserBlocked(userId) {
  if (isAdmin(userId)) return false;
  const user = await User.findOne({ userId });
  return user && user.isBlocked;
}

// Enhanced sendToChannel function with milestone message
async function sendToChannel(memberCount = 0, isTest = false) {
  try {
    const rewardLevel = Math.floor(memberCount / INVITES_PER_REWARD) * INVITES_PER_REWARD;
    
    if (rewardLevel === 0 && !isTest) return;
    
    const imageReward = await Reward.findOne({ level: rewardLevel, isImageFile: true });
    const fileReward = await Reward.findOne({ level: rewardLevel, isImageFile: false });
    
    if (!imageReward && !fileReward) {
      console.log(`No rewards found for level ${rewardLevel}`);
      return;
    }
    
    const postId = `${Date.now()}_${rewardLevel}`;
    let imageMessageId = null;
    let fileMessageId = null;
    let results = [];
    
    // Send image first - download and re-upload as photo
    if (imageReward) {
      try {
        const fileToSend = imageReward.imagePath || imageReward.filePath;
        console.log(`Downloading and sending image as photo: ${imageReward.fileName}`);
        
        const imageMessage = await downloadAndSendAsPhoto(CHANNEL_ID, fileToSend, imageReward.fileName);
        imageMessageId = imageMessage.message_id;
        results.push(`✅ Image downloaded and sent as photo: ${imageReward.fileName}`);
        
      } catch (downloadError) {
        console.error('Download and photo send failed:', downloadError.message);
        try {
          const fileToSend = imageReward.imagePath || imageReward.filePath;
          const imageMessage = await bot.sendDocument(CHANNEL_ID, fileToSend);
          imageMessageId = imageMessage.message_id;
          results.push(`📄 Image sent as document (download failed): ${imageReward.fileName}`);
        } catch (docError) {
          console.error('Document fallback also failed:', docError);
          results.push(`❌ Image failed completely: ${docError.message}`);
        }
      }
    }
    
    // Send file second - check if it's an image and download/re-upload
    if (fileReward) {
      try {
        const isImageByFilename = isDocumentAnImage(fileReward.fileName);
        
        if (isImageByFilename) {
          console.log(`Downloading and sending file as photo: ${fileReward.fileName}`);
          try {
            const fileMessage = await downloadAndSendAsPhoto(CHANNEL_ID, fileReward.filePath, fileReward.fileName);
            fileMessageId = fileMessage.message_id;
            results.push(`✅ File downloaded and sent as photo: ${fileReward.fileName}`);
          } catch (downloadError) {
            console.error('Download and photo send failed for file:', downloadError.message);
            const fileMessage = await bot.sendDocument(CHANNEL_ID, fileReward.filePath);
            fileMessageId = fileMessage.message_id;
            results.push(`📄 File sent as document (download failed): ${fileReward.fileName}`);
          }
        } else {
          const fileMessage = await bot.sendDocument(CHANNEL_ID, fileReward.filePath);
          fileMessageId = fileMessage.message_id;
          results.push(`📁 File sent as document: ${fileReward.fileName}`);
        }
      } catch (error) {
        console.error('Error sending file reward:', error);
        results.push(`❌ File failed: ${error.message}`);
      }
    }
    
    // Send milestone message after content
    if ((imageMessageId || fileMessageId) && !isTest) {
      try {
        const nextMilestone = Math.ceil((memberCount + 1) / INVITES_PER_REWARD) * INVITES_PER_REWARD;
        const needed = Math.max(0, nextMilestone - memberCount);
        
        const milestoneMessage = `🎯 Next content unlock: ${needed} more members needed! Current: ${memberCount}/${nextMilestone}`;
        
        await bot.sendMessage(CHANNEL_ID, milestoneMessage);
        results.push(`📊 Milestone message sent: ${needed} more needed`);
      } catch (error) {
        console.error('Error sending milestone message:', error);
        results.push(`❌ Milestone message failed: ${error.message}`);
      }
    }
    
    // Track the post only if something was sent
    if (imageMessageId || fileMessageId) {
      const channelPost = new ChannelPost({
        postId,
        rewardLevel,
        imageMessageId,
        fileMessageId,
        communityReferrals: isTest ? 0 : memberCount
      });
      await channelPost.save();
      
      // Update stats only for non-test posts
      if (!isTest) {
        await Stats.findOneAndUpdate(
          {},
          { lastChannelPost: new Date() },
          { upsert: true }
        );
      }
    }
    
    return { imageMessageId, fileMessageId, results };
    
  } catch (error) {
    console.error('Error in sendToChannel:', error);
    throw error;
  }
}

// Export for admin_features.js
global.sendToChannel = sendToChannel;

// Check and send fallback content - now configurable via environment variable
async function checkAndSendFallback() {
  try {
    const stats = await Stats.findOne();
    const now = new Date();
    const lastPost = stats?.lastChannelPost;
    
    const fallbackIntervalMs = AUTO_POST_HOURS * 60 * 60 * 1000;
    
    if (!lastPost || (now - lastPost) >= fallbackIntervalMs) {
      console.log(`${AUTO_POST_HOURS} hours passed, sending fallback content...`);
      
      const rewards = await Reward.find();
      if (rewards.length > 0) {
        const currentCount = stats?.communityMemberCount || 0;
        await sendToChannel(currentCount);
        
        // Notify admins
        for (const adminId of ADMIN_IDS) {
          try {
            await bot.sendMessage(adminId, 
              `Fallback content sent to @${CHANNEL_USERNAME}!\n\n` +
              `Last post: ${lastPost ? Math.floor((now - lastPost) / (1000 * 60 * 60)) : `${AUTO_POST_HOURS}+`} hours ago\n` +
              `Community members: ${currentCount}\n` +
              `Auto-post interval: ${AUTO_POST_HOURS} hours`
            );
          } catch (error) {
            console.error(`Error notifying admin ${adminId}:`, error);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error in fallback check:', error);
  }
}

// Enhanced community counting - now counts all channel joins
async function countMember(user) {
  // Count individual referral if applicable
  if (user.referredBy && !user.referralCounted) {
    const referrer = await User.findOne({ userId: user.referredBy });
    if (referrer) {
      referrer.inviteCount += 1;
      referrer.totalEarned += 1;
      await referrer.save();
      
      user.referralCounted = true;
      await user.save();
      
      // Check individual reward
      const rewardLevel = Math.floor(referrer.inviteCount / INVITES_PER_REWARD) * INVITES_PER_REWARD;
      if (rewardLevel > referrer.lastRewardLevel && rewardLevel > 0) {
        await sendReward(referrer.userId, rewardLevel);
        referrer.lastRewardLevel = rewardLevel;
        await referrer.save();
      }
      
      // Notify referrer
      bot.sendMessage(referrer.userId, 
        `Referral confirmed! ${user.firstName} joined StitchVault!\n\n` +
        `Your referrals: ${referrer.inviteCount}\n` +
        `Keep sharing to unlock more rewards!`
      ).catch(() => {});
    }
  }
  
  // Update community member count (for all joins, not just referrals)
  const stats = await Stats.findOneAndUpdate(
    {},
    { $inc: { communityMemberCount: 1 } },
    { upsert: true, new: true }
  );
  
  const memberCount = stats.communityMemberCount;
  
  // Community milestone reached - check if we hit a milestone
  if (memberCount % INVITES_PER_REWARD === 0) {
    await sendToChannel(memberCount);
    
    // Notify admins
    for (const adminId of ADMIN_IDS) {
      try {
        await bot.sendMessage(adminId, 
          `Community Milestone Reached!\n\n` +
          `Total members: ${memberCount}\n` +
          `Latest join: ${user.firstName}${user.referredBy ? ' (referred)' : ' (direct)'}\n` +
          `Content sent to @${CHANNEL_USERNAME}`
        );
      } catch (error) {
        console.error(`Error notifying admin:`, error);
      }
    }
  }
  
  return memberCount;
}

// Bulk upload helper functions
function extractNumberFromFilename(filename) {
  const match = filename.match(/(\d+)/);
  return match ? parseInt(match[1]) : 999;
}

function isImageFileType(filename) {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  const ext = path.extname(filename.toLowerCase());
  return imageExtensions.includes(ext);
}

function isDocumentAnImage(filename) {
  return isImageFileType(filename);
}

// Download and re-upload file as photo
async function downloadAndSendAsPhoto(channelId, fileId, fileName, caption = null) {
  try {
    const fileInfo = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
    
    const https = require('https');
    const http = require('http');
    
    return new Promise((resolve, reject) => {
      const protocol = fileUrl.startsWith('https:') ? https : http;
      
      protocol.get(fileUrl, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed: ${response.statusCode}`));
          return;
        }
        
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', async () => {
          try {
            const buffer = Buffer.concat(chunks);
            
            const photoMessage = await bot.sendPhoto(channelId, buffer, {
              caption: caption,
              filename: fileName
            });
            
            resolve(photoMessage);
          } catch (error) {
            reject(error);
          }
        });
      }).on('error', reject);
    });
  } catch (error) {
    throw new Error(`Download and send failed: ${error.message}`);
  }
}

async function finishBulkUpload(userId) {
  const session = global.bulkUploadSessions?.[userId];
  if (!session) return;
  
  const chatId = session.chatId;
  const files = session.files;
  
  delete global.bulkUploadSessions[userId];
  
  if (files.length === 0) {
    return bot.sendMessage(chatId, 'No files received for bulk upload.');
  }
  
  bot.sendMessage(chatId, `Processing ${files.length} files...`);
  
  files.sort((a, b) => {
    const numA = extractNumberFromFilename(a.fileName);
    const numB = extractNumberFromFilename(b.fileName);
    return numA - numB;
  });
  
  let processed = 0;
  let errors = 0;
  
  for (const file of files) {
    try {
      const fileNumber = extractNumberFromFilename(file.fileName);
      const level = fileNumber * INVITES_PER_REWARD;
      const isImageFile = isImageFileType(file.fileName);
      
      const existingReward = await Reward.findOne({ level, isImageFile });
      if (existingReward) {
        continue;
      }
      
      const reward = new Reward({
        rewardId: Date.now() + Math.random() * 1000,
        level: level,
        fileName: file.fileName,
        filePath: file.fileId,
        imageName: isImageFile ? file.fileName : null,
        imagePath: isImageFile ? file.fileId : null,
        description: `Level ${level} ${isImageFile ? 'preview' : 'download'}`,
        addedBy: userId,
        isImageFile: isImageFile,
        originalOrder: fileNumber
      });
      
      await reward.save();
      processed++;
      
    } catch (error) {
      console.error(`Error processing ${file.fileName}:`, error);
      errors++;
    }
  }
  
  const resultMessage = 
    `Bulk Upload Complete!\n\n` +
    `Processed: ${processed}\n` +
    `Errors: ${errors}\n` +
    `Total: ${files.length}`;
  
  await bot.sendMessage(chatId, resultMessage);
  await updateStats();
}

async function sendReward(userId, level) {
  try {
    const rewards = await Reward.find({ level });
    if (rewards.length === 0) return;
    
    for (const reward of rewards) {
      await sendRewardFile(userId, reward, `Level ${level} reward unlocked!`);
    }
  } catch (error) {
    console.error('Send reward error:', error);
  }
}

async function sendRewardFile(userId, reward, message) {
  try {
    await bot.sendMessage(userId, message);
    
    const isImageByFilename = isDocumentAnImage(reward.fileName);
    
    if (reward.isImageFile || isImageByFilename) {
      try {
        await downloadAndSendAsPhoto(userId, reward.imagePath || reward.filePath, reward.fileName, `${reward.fileName} - Level ${reward.level}`);
      } catch (downloadError) {
        console.log('Photo download failed for user reward, sending as document:', downloadError.message);
        await bot.sendDocument(userId, reward.imagePath || reward.filePath, {
          caption: `${reward.fileName} - Level ${reward.level}`
        });
      }
    } else {
      await bot.sendDocument(userId, reward.filePath, {
        caption: `${reward.fileName} - Level ${reward.level}`
      });
    }
  } catch (error) {
    console.error('Send reward file error:', error);
  }
}

global.sendRewardFile = sendRewardFile;

// BOT COMMANDS

// Fixed Start command with better referral handling
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const referralParam = match[1].trim();
  
  try {
    if (await checkUserBlocked(userId)) {
      return bot.sendMessage(chatId, 'You are temporarily restricted from using this bot.');
    }

    await updateUserActivity(userId);
    
    let user = await User.findOne({ userId });
    let isNewUser = false;
    let hasReferrer = false;
    
    if (!user) {
      isNewUser = true;
      const referralCode = generateReferralCode(userId);
      
      user = new User({
        userId,
        username: msg.from.username,
        firstName: msg.from.first_name,
        lastName: msg.from.last_name,
        referralCode
      });
      
      if (referralParam.startsWith('ref_')) {
        const referrer = await User.findOne({ referralCode: referralParam });
        
        if (referrer && referrer.userId !== userId) {
          user.referredBy = referrer.userId;
          hasReferrer = true;
          
          bot.sendMessage(referrer.userId, 
            `Someone started the bot through your invite!\n` +
            `They need to join @${CHANNEL_USERNAME} to help reach community goals.\n` +
            `Your referrals: ${referrer.inviteCount}`
          ).catch(() => {});
        }
      }
      
      await user.save();
      await updateStats();
      
      // Send welcome bonus
      if (!user.bonusReceived) {
        const bonusReward = await Reward.findOne({ level: 0 });
        if (bonusReward) {
          await sendRewardFile(userId, bonusReward, "Welcome to StitchVault!");
          user.bonusReceived = true;
          await user.save();
        }
      }
    }
    
    // Get community stats with FIXED calculation
    const stats = await Stats.findOne() || {};
    const memberCount = stats.communityMemberCount || 0;
    const nextMilestone = Math.ceil((memberCount + 1) / INVITES_PER_REWARD) * INVITES_PER_REWARD;
    const needed = Math.max(0, nextMilestone - memberCount);
    
    let welcomeMessage;
    
    if (isNewUser && hasReferrer) {
      welcomeMessage = 
        `🎉 Welcome to StitchVault Community!\n\n` +
        `🔥 You were invited to join our creative community!\n` +
        `🎁 You received a welcome bonus!\n\n` +
        `👆 **Click the button below to join our channel and activate your referral!**\n\n` +
        `🏆 Community Progress: ${memberCount} members\n` +
        `🎯 Next unlock: ${needed} more members needed\n\n` +
        `💡 Every ${INVITES_PER_REWARD} community members unlocks exclusive content for everyone!`;
    } else if (isNewUser) {
      welcomeMessage = 
        `🎉 Welcome to StitchVault Community!\n\n` +
        `🎁 You received a welcome bonus!\n` +
        `📱 **Join our design community to get started!**\n\n` +
        `🏆 Community Progress: ${memberCount} members\n` +
        `🎯 Next unlock: ${needed} more needed\n\n` +
        `🔗 Get your invite link: /link\n` +
        `❓ Need help: /help`;
    } else {
      welcomeMessage = 
        `👋 Welcome back to StitchVault, ${msg.from.first_name}!\n\n` +
        `👤 Your referrals: ${user.inviteCount}\n` +
        `🏆 Community total: ${memberCount} members\n` +
        `🎯 Next unlock: ${needed} more members\n\n` +
        `🔗 Your invite link: /link\n` +
        `📊 Your stats: /stats`;
    }
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '📱 Join StitchVault', url: `https://t.me/${CHANNEL_USERNAME}` }],
        [{ text: '🔗 Get Invite Link', callback_data: 'get_link' }],
        [{ text: '📊 Stats', callback_data: 'my_stats' }, { text: '❓ Help', callback_data: 'help' }]
      ]
    };
    
    await bot.sendMessage(chatId, welcomeMessage, { reply_markup: keyboard });
    
  } catch (error) {
    console.error('Start command error:', error);
    bot.sendMessage(chatId, 'An error occurred. Please try again.');
  }
});

// Fixed Link command with proper calculation
bot.onText(/\/link/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  try {
    if (await checkUserBlocked(userId)) {
      return bot.sendMessage(chatId, 'You are restricted from using this bot.');
    }

    await updateUserActivity(userId);
    
    const user = await User.findOne({ userId });
    if (!user) {
      return bot.sendMessage(chatId, 'Please start the bot first with /start');
    }
    
    const stats = await Stats.findOne() || {};
    const memberCount = stats.communityMemberCount || 0;
    const nextMilestone = Math.ceil((memberCount + 1) / INVITES_PER_REWARD) * INVITES_PER_REWARD;
    const needed = Math.max(0, nextMilestone - memberCount);
    
    const inviteLink = `https://t.me/${BOT_USERNAME}?start=${user.referralCode}`;
    
    const message = 
      `Your StitchVault Invite Link:\n` +
      `${inviteLink}\n\n` +
      `Your referrals: ${user.inviteCount}\n` +
      `Community progress: ${memberCount} members\n` +
      `Community goal: ${needed} more to unlock designs\n\n` +
      `Share to help unlock exclusive collections!\n` +
      `Friends must join @${CHANNEL_USERNAME} to count`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: 'Share Link', url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent('Join StitchVault creative community!')}` }],
        [{ text: 'Join Channel', url: `https://t.me/${CHANNEL_USERNAME}` }]
      ]
    };
    
    await bot.sendMessage(chatId, message, { reply_markup: keyboard });
    
  } catch (error) {
    console.error('Link command error:', error);
    bot.sendMessage(chatId, 'An error occurred.');
  }
});

// Fixed Stats command with proper calculation
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  try {
    if (await checkUserBlocked(userId)) {
      return bot.sendMessage(chatId, 'You are restricted from using this bot.');
    }

    await updateUserActivity(userId);
    
    const user = await User.findOne({ userId });
    if (!user) {
      return bot.sendMessage(chatId, 'Please start the bot first with /start');
    }
    
    const stats = await Stats.findOne() || {};
    const memberCount = stats.communityMemberCount || 0;
    const nextMilestone = Math.ceil((memberCount + 1) / INVITES_PER_REWARD) * INVITES_PER_REWARD;
    const needed = Math.max(0, nextMilestone - memberCount);
    
    const userNext = Math.ceil((user.inviteCount + 1) / INVITES_PER_REWARD) * INVITES_PER_REWARD;
    const userNeeded = Math.max(0, userNext - user.inviteCount);
    
    let referralStatus = '';
    if (user.referredBy && !user.referralCounted) {
      referralStatus = `\nPending referral (join @${CHANNEL_USERNAME} to activate)`;
    } else if (user.referredBy && user.referralCounted) {
      referralStatus = `\nReferral counted`;
    }
    
    const message = 
      `StitchVault Stats:\n\n` +
      `Your Profile:\n` +
      `Name: ${user.firstName} ${user.lastName || ''}\n` +
      `Joined: ${user.joinedAt.toDateString()}\n` +
      `Channel Member: ${user.joinedChannel ? 'Yes' : 'No'}${referralStatus}\n\n` +
      `Your Progress:\n` +
      `Your referrals: ${user.inviteCount}\n` +
      `Next personal reward: ${userNeeded} more referrals\n` +
      `Total earned: ${user.totalEarned}\n\n` +
      `Community Progress:\n` +
      `Total members: ${memberCount}\n` +
      `Next unlock: ${needed} more members\n` +
      `Last content: ${stats.lastChannelPost ? stats.lastChannelPost.toDateString() : 'None yet'}\n\n` +
      `Every ${INVITES_PER_REWARD} community members = new exclusive content!`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: 'Get Invite Link', callback_data: 'get_link' }],
        [{ text: 'Join Channel', url: `https://t.me/${CHANNEL_USERNAME}` }]
      ]
    };
    
    await bot.sendMessage(chatId, message, { reply_markup: keyboard });
    
  } catch (error) {
    console.error('Stats command error:', error);
    bot.sendMessage(chatId, 'An error occurred.');
  }
});

// Help command
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  
  const helpMessage = 
    `StitchVault Community Help\n\n` +
    `How it works:\n` +
    `1. Get your invite link with /link\n` +
    `2. Share with friends\n` +
    `3. Friends must join @${CHANNEL_USERNAME}\n` +
    `4. Every ${INVITES_PER_REWARD} community members unlock exclusive content!\n\n` +
    `Commands:\n` +
    `/start - Start the bot\n` +
    `/link - Get your invite link\n` +
    `/stats - View your statistics\n` +
    `/help - Show this help\n\n` +
    `Rewards:\n` +
    `Welcome bonus on first start\n` +
    `Personal rewards for your referrals\n` +
    `Community unlocks exclusive content for everyone\n\n` +
    `Need support? Contact our admins!`;
  
  const keyboard = {
    inline_keyboard: [
      [{ text: 'Join StitchVault', url: `https://t.me/${CHANNEL_USERNAME}` }],
      [{ text: 'Get Invite Link', callback_data: 'get_link' }]
    ]
  };
  
  await bot.sendMessage(chatId, helpMessage, { reply_markup: keyboard });
});

// ADMIN COMMANDS

bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) {
    return bot.sendMessage(chatId, 'Not authorized.');
  }
  
  const adminHelp = 
    `StitchVault Admin Commands:\n\n` +
    `Analytics:\n` +
    `/stats_admin - Bot statistics\n` +
    `/users - List users\n` +
    `/user <id> - User details\n\n` +
    `Content:\n` +
    `/reward <level> - Add single reward\n` +
    `/bulk_upload - Bulk upload help\n` +
    `/bulk_upload_files - Start bulk upload\n` +
    `/rewards - List rewards\n` +
    `/delete_reward <id> - Delete reward\n\n` +
    `Channel:\n` +
    `/send_channel <level> - Manual post\n` +
    `/channel_history - Post history\n` +
    `/test_channel <level> - Test post\n\n` +
    `Users:\n` +
    `/broadcast <msg> - Message all\n` +
    `/block <id> - Block user\n` +
    `/unblock <id> - Unblock user\n` +
    `/reset_community - Reset counter\n` +
    `/backup - Download backup\n\n` +
    `Settings:\n` +
    `Auto-post interval: ${AUTO_POST_HOURS} hours\n` +
    `Members per reward: ${INVITES_PER_REWARD}\n` +
    `Change via AUTO_POST_HOURS in .env`;
  
  await bot.sendMessage(chatId, adminHelp);
});

bot.onText(/\/stats_admin/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) return;
  
  try {
    const stats = await Stats.findOne() || {};
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ 
      lastActivity: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } 
    });
    const channelMembers = await User.countDocuments({ joinedChannel: true });
    const totalInvites = await User.aggregate([
      { $group: { _id: null, total: { $sum: '$inviteCount' } } }
    ]);
    const totalRewards = await Reward.countDocuments();
    const pendingReferrals = await User.countDocuments({ 
      referredBy: { $exists: true }, 
      referralCounted: false 
    });
    const channelPosts = await ChannelPost.countDocuments();
    const memberCount = stats.communityMemberCount || 0;
    
    const message = 
      `StitchVault Admin Statistics:\n\n` +
      `Users:\n` +
      `Total: ${totalUsers}\n` +
      `Active (7d): ${activeUsers}\n` +
      `Channel members: ${channelMembers}\n` +
      `Pending referrals: ${pendingReferrals}\n\n` +
      `Community Progress:\n` +
      `Community members: ${memberCount}\n` +
      `Individual referrals: ${totalInvites[0]?.total || 0}\n` +
      `Next milestone: ${Math.ceil((memberCount + 1) / INVITES_PER_REWARD) * INVITES_PER_REWARD}\n\n` +
      `Content:\n` +
      `Total rewards: ${totalRewards}\n` +
      `Channel posts: ${channelPosts}\n` +
      `Last post: ${stats.lastChannelPost ? stats.lastChannelPost.toLocaleString() : 'Never'}\n\n` +
      `Settings:\n` +
      `Auto-post interval: ${AUTO_POST_HOURS} hours\n` +
      `Members per reward: ${INVITES_PER_REWARD}\n\n` +
      `Updated: ${new Date().toLocaleString()}`;
    
    await bot.sendMessage(chatId, message);
    
  } catch (error) {
    console.error('Admin stats error:', error);
    bot.sendMessage(chatId, 'Error fetching statistics.');
  }
});

bot.onText(/\/reset_community/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) return;
  
  try {
    await Stats.findOneAndUpdate(
      {},
      { communityMemberCount: 0 },
      { upsert: true }
    );
    
    bot.sendMessage(chatId, 'Community member counter has been reset to 0.');
    
  } catch (error) {
    console.error('Reset community error:', error);
    bot.sendMessage(chatId, 'Error resetting community counter.');
  }
});

// Include other admin commands (bulk upload, rewards management, etc.)
bot.onText(/\/bulk_upload/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) return;
  
  const helpMessage = 
    `StitchVault Bulk Upload Instructions:\n\n` +
    `1. Use /bulk_upload_files to start session\n` +
    `2. Send multiple files/images\n` +
    `3. Use /bulk_finish when done\n` +
    `4. Images become previews, ZIP/RAR become downloads\n\n` +
    `Naming Convention:\n` +
    `"1.jpg" = Level ${INVITES_PER_REWARD} preview\n` +
    `"1.zip" = Level ${INVITES_PER_REWARD} download\n` +
    `"2.png" = Level ${INVITES_PER_REWARD * 2} preview\n` +
    `"2.rar" = Level ${INVITES_PER_REWARD * 2} download\n\n` +
    `Commands:\n` +
    `/bulk_upload_files - Start session\n` +
    `/bulk_status - Check progress\n` +
    `/bulk_finish - Complete upload\n` +
    `/bulk_cancel - Cancel session`;
  
  await bot.sendMessage(chatId, helpMessage);
});

bot.onText(/\/bulk_upload_files/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) {
    return bot.sendMessage(chatId, 'Not authorized');
  }
  
  bot.sendMessage(chatId, 
    `Bulk Upload Session Started!\n\n` +
    `Send files now (images and documents)\n` +
    `Session expires in 5 minutes\n` +
    `Use /bulk_finish when complete`
  );
  
  global.bulkUploadSessions[userId] = {
    files: [],
    startTime: Date.now(),
    chatId: chatId
  };
  
  setTimeout(() => {
    if (global.bulkUploadSessions[userId]) {
      finishBulkUpload(userId);
    }
  }, 5 * 60 * 1000);
});

bot.onText(/\/bulk_finish/, async (msg) => {
  const userId = msg.from.id;
  if (!isAdmin(userId)) return;
  await finishBulkUpload(userId);
});

bot.onText(/\/bulk_status/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) return;
  
  const session = global.bulkUploadSessions?.[userId];
  
  if (!session) {
    return bot.sendMessage(chatId, 'No active bulk upload session.');
  }
  
  const elapsed = Math.floor((Date.now() - session.startTime) / 1000);
  const remaining = Math.max(0, 300 - elapsed);
  
  const message = 
    `Bulk Upload Status:\n\n` +
    `Files received: ${session.files.length}\n` +
    `Elapsed: ${elapsed}s\n` +
    `Remaining: ${remaining}s\n\n` +
    `Recent files:\n` +
    session.files.slice(-5).map(f => `${f.fileName}`).join('\n');
  
  await bot.sendMessage(chatId, message);
});

bot.onText(/\/bulk_cancel/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) return;
  
  if (global.bulkUploadSessions?.[userId]) {
    delete global.bulkUploadSessions[userId];
    bot.sendMessage(chatId, 'Bulk upload session cancelled.');
  } else {
    bot.sendMessage(chatId, 'No active session to cancel.');
  }
});

bot.onText(/\/send_channel (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const level = parseInt(match[1]);
  
  if (!isAdmin(userId)) return;
  
  try {
    const imageReward = await Reward.findOne({ level, isImageFile: true });
    const fileReward = await Reward.findOne({ level, isImageFile: false });
    
    if (!imageReward && !fileReward) {
      return bot.sendMessage(chatId, `No rewards found for level ${level}`);
    }
    
    const result = await sendToChannel(level, false);
    
    if (result && result.results) {
      bot.sendMessage(chatId, 
        `Manual Channel Post Results:\n\n` +
        result.results.join('\n') +
        `\n\nChannel: @${CHANNEL_USERNAME}`
      );
    } else {
      bot.sendMessage(chatId, `Failed to send content to channel`);
    }
    
  } catch (error) {
    console.error('Send channel error:', error);
    bot.sendMessage(chatId, `Error: ${error.message}`);
  }
});

bot.onText(/\/test_channel (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const level = parseInt(match[1]);
  
  if (!isAdmin(userId)) return;
  
  try {
    const imageReward = await Reward.findOne({ level, isImageFile: true });
    const fileReward = await Reward.findOne({ level, isImageFile: false });
    
    if (!imageReward && !fileReward) {
      return bot.sendMessage(chatId, `No rewards found for level ${level}`);
    }
    
    const result = await sendToChannel(level, true);
    
    if (result && result.results) {
      bot.sendMessage(chatId, 
        `Test Channel Post Results:\n\n` +
        result.results.join('\n') +
        `\n\nChannel: @${CHANNEL_USERNAME}\n` +
        `This was a test post (not counted toward community stats)`
      );
    } else {
      bot.sendMessage(chatId, `Failed to send test content to channel`);
    }
    
  } catch (error) {
    console.error('Test channel error:', error);
    bot.sendMessage(chatId, `Error: ${error.message}`);
  }
});

bot.onText(/\/rewards/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) return;
  
  try {
    const rewards = await Reward.find().sort({ level: 1, isImageFile: -1 });
    
    if (rewards.length === 0) {
      return bot.sendMessage(chatId, 'No rewards found.');
    }
    
    let message = `StitchVault Rewards List:\n\n`;
    
    rewards.forEach(reward => {
      const typeText = reward.isImageFile ? 'Image' : 'File';
      
      message += 
        `Level ${reward.level} (${typeText})\n` +
        `File: ${reward.fileName}\n` +
        `ID: ${reward.rewardId}\n` +
        `Added: ${reward.addedAt.toDateString()}\n\n`;
    });
    
    await bot.sendMessage(chatId, message);
    
  } catch (error) {
    console.error('Rewards list error:', error);
    bot.sendMessage(chatId, 'Error fetching rewards.');
  }
});

bot.onText(/\/delete_reward (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const rewardId = parseInt(match[1]);
  
  if (!isAdmin(userId)) return;
  
  try {
    const reward = await Reward.findOneAndDelete({ rewardId });
    
    if (!reward) {
      return bot.sendMessage(chatId, 'Reward not found.');
    }
    
    bot.sendMessage(chatId, 
      `Reward deleted successfully!\n` +
      `File: ${reward.fileName}\n` +
      `Level: ${reward.level}\n` +
      `Type: ${reward.isImageFile ? 'Image' : 'File'}`
    );
    
  } catch (error) {
    console.error('Delete reward error:', error);
    bot.sendMessage(chatId, 'Error deleting reward.');
  }
});

bot.onText(/\/channel_history/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) return;
  
  try {
    const posts = await ChannelPost.find().sort({ sentAt: -1 }).limit(10);
    
    if (posts.length === 0) {
      return bot.sendMessage(chatId, 'No channel posts found.');
    }
    
    let message = `Recent Channel Posts:\n\n`;
    
    posts.forEach((post, index) => {
      const postType = post.communityReferrals === 0 ? 'Manual/Test' : `Community (${post.communityReferrals} members)`;
      message += 
        `${index + 1}. Level ${post.rewardLevel} (${postType})\n` +
        `${post.sentAt.toLocaleString()}\n` +
        `Image: ${post.imageMessageId ? 'Yes' : 'No'}\n` +
        `File: ${post.fileMessageId ? 'Yes' : 'No'}\n\n`;
    });
    
    await bot.sendMessage(chatId, message);
    
  } catch (error) {
    console.error('Channel history error:', error);
    bot.sendMessage(chatId, 'Error fetching channel history.');
  }
});

// Include admin_features.js commands
try {
  require('./admin_features.js');
  console.log('Admin features loaded successfully');
} catch (error) {
  console.log('Admin features file not found, continuing without it');
}

// Handle file uploads during bulk session
bot.on('document', async (msg) => {
  const userId = msg.from.id;
  const session = global.bulkUploadSessions?.[userId];
  
  if (!session || !isAdmin(userId)) return;
  
  const file = {
    fileName: msg.document.file_name,
    fileId: msg.document.file_id,
    fileSize: msg.document.file_size
  };
  
  session.files.push(file);
  
  bot.sendMessage(msg.chat.id, 
    `File added: ${file.fileName}\n` +
    `Total: ${session.files.length} files\n` +
    `Send more or /bulk_finish when done`
  );
});

bot.on('photo', async (msg) => {
  const userId = msg.from.id;
  const session = global.bulkUploadSessions?.[userId];
  
  if (!session || !isAdmin(userId)) return;
  
  const photo = msg.photo[msg.photo.length - 1];
  const fileName = msg.caption || `design_${Date.now()}.jpg`;
  
  const file = {
    fileName: fileName,
    fileId: photo.file_id,
    fileSize: photo.file_size
  };
  
  session.files.push(file);
  
  bot.sendMessage(msg.chat.id, 
    `Image added: ${fileName}\n` +
    `Total: ${session.files.length} files\n` +
    `Send more or /bulk_finish when done`
  );
});

// Fixed callback query handler with proper calculations
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;
  
  try {
    if (!isAdmin(userId) && await checkUserBlocked(userId)) {
      await bot.answerCallbackQuery(callbackQuery.id, { 
        text: 'You are restricted from using this bot.',
        show_alert: true 
      });
      return;
    }
    
    if (data === 'get_link') {
      const user = await User.findOne({ userId });
      if (!user) {
        await bot.answerCallbackQuery(callbackQuery.id, { 
          text: 'Please start the bot first with /start',
          show_alert: true 
        });
        return;
      }
      
      const stats = await Stats.findOne() || {};
      const memberCount = stats.communityMemberCount || 0;
      const nextMilestone = Math.ceil((memberCount + 1) / INVITES_PER_REWARD) * INVITES_PER_REWARD;
      const needed = Math.max(0, nextMilestone - memberCount);
      
      const inviteLink = `https://t.me/${BOT_USERNAME}?start=${user.referralCode}`;
      
      const message = 
        `Your StitchVault Link:\n` +
        `${inviteLink}\n\n` +
        `Your referrals: ${user.inviteCount}\n` +
        `Community: ${memberCount} members\n` +
        `Next unlock: ${needed} more members\n\n` +
        `Share to unlock exclusive designs!\n` +
        `Friends must join @${CHANNEL_USERNAME}`;
      
      const keyboard = {
        inline_keyboard: [
          [{ text: 'Share Link', url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent('Join StitchVault creative community!')}` }],
          [{ text: 'Join Channel', url: `https://t.me/${CHANNEL_USERNAME}` }]
        ]
      };
      
      await bot.sendMessage(chatId, message, { reply_markup: keyboard });
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Here is your invite link!' });
      
    } else if (data === 'my_stats') {
      const user = await User.findOne({ userId });
      if (!user) {
        await bot.answerCallbackQuery(callbackQuery.id, { 
          text: 'Please start the bot first with /start',
          show_alert: true 
        });
        return;
      }
      
      const stats = await Stats.findOne() || {};
      const memberCount = stats.communityMemberCount || 0;
      const nextMilestone = Math.ceil((memberCount + 1) / INVITES_PER_REWARD) * INVITES_PER_REWARD;
      const needed = Math.max(0, nextMilestone - memberCount);
      
      const userNext = Math.ceil((user.inviteCount + 1) / INVITES_PER_REWARD) * INVITES_PER_REWARD;
      const userNeeded = Math.max(0, userNext - user.inviteCount);
      
      let referralStatus = '';
      if (user.referredBy && !user.referralCounted) {
        referralStatus = `\nPending referral (join @${CHANNEL_USERNAME} to activate)`;
      } else if (user.referredBy && user.referralCounted) {
        referralStatus = `\nReferral counted`;
      }
      
      const message = 
        `StitchVault Stats:\n\n` +
        `Your Profile:\n` +
        `Name: ${user.firstName} ${user.lastName || ''}\n` +
        `Joined: ${user.joinedAt.toDateString()}\n` +
        `Channel Member: ${user.joinedChannel ? 'Yes' : 'No'}${referralStatus}\n\n` +
        `Your Progress:\n` +
        `Your referrals: ${user.inviteCount}\n` +
        `Next personal reward: ${userNeeded} more referrals\n` +
        `Total earned: ${user.totalEarned}\n\n` +
        `Community Progress:\n` +
        `Total members: ${memberCount}\n` +
        `Next unlock: ${needed} more members\n` +
        `Last content: ${stats.lastChannelPost ? stats.lastChannelPost.toDateString() : 'None yet'}\n\n` +
        `Every ${INVITES_PER_REWARD} community members = new exclusive content!`;
      
      const keyboard = {
        inline_keyboard: [
          [{ text: 'Get Invite Link', callback_data: 'get_link' }],
          [{ text: 'Join Channel', url: `https://t.me/${CHANNEL_USERNAME}` }]
        ]
      };
      
      await bot.sendMessage(chatId, message, { reply_markup: keyboard });
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Here are your stats!' });
      
    } else if (data === 'help') {
      const helpMessage = 
        `StitchVault Community Help\n\n` +
        `How it works:\n` +
        `1. Get your invite link with /link\n` +
        `2. Share with friends\n` +
        `3. Friends must join @${CHANNEL_USERNAME}\n` +
        `4. Every ${INVITES_PER_REWARD} community members unlock exclusive content!\n\n` +
        `Commands:\n` +
        `/start - Start the bot\n` +
        `/link - Get your invite link\n` +
        `/stats - View your statistics\n` +
        `/help - Show this help\n\n` +
        `Rewards:\n` +
        `Welcome bonus on first start\n` +
        `Personal rewards for your referrals\n` +
        `Community unlocks exclusive content for everyone\n\n` +
        `Need support? Contact our admins!`;
      
      const keyboard = {
        inline_keyboard: [
          [{ text: 'Join StitchVault', url: `https://t.me/${CHANNEL_USERNAME}` }],
          [{ text: 'Get Invite Link', callback_data: 'get_link' }]
        ]
      };
      
      await bot.sendMessage(chatId, helpMessage, { reply_markup: keyboard });
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Help information sent!' });
      
    } else if (isAdmin(userId)) {
      // Handle admin callback queries
      if (data.startsWith('users_page_')) {
        await bot.answerCallbackQuery(callbackQuery.id);
      } else if (data.startsWith('admin_block_')) {
        const targetUserId = parseInt(data.split('_')[2]);
        const user = await User.findOneAndUpdate({ userId: targetUserId }, { isBlocked: true });
        if (user) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: 'User blocked' });
          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
            chat_id: chatId,
            message_id: callbackQuery.message.message_id
          });
        } else {
          await bot.answerCallbackQuery(callbackQuery.id, { text: 'User not found!', show_alert: true });
        }
      } else if (data.startsWith('admin_unblock_')) {
        const targetUserId = parseInt(data.split('_')[2]);
        const user = await User.findOneAndUpdate({ userId: targetUserId }, { isBlocked: false });
        if (user) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: 'User unblocked' });
          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
            chat_id: chatId,
            message_id: callbackQuery.message.message_id
          });
        } else {
          await bot.answerCallbackQuery(callbackQuery.id, { text: 'User not found!', show_alert: true });
        }
      } else if (data.startsWith('admin_reset_')) {
        const targetUserId = parseInt(data.split('_')[2]);
        const user = await User.findOneAndUpdate(
          { userId: targetUserId },
          {
            inviteCount: 0,
            totalEarned: 0,
            lastRewardLevel: 0,
            bonusReceived: false,
            referralCounted: false
          }
        );
        if (user) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: 'Stats reset' });
        } else {
          await bot.answerCallbackQuery(callbackQuery.id, { text: 'User not found!', show_alert: true });
        }
      } else {
        await bot.answerCallbackQuery(callbackQuery.id);
      }
    } else {
      await bot.answerCallbackQuery(callbackQuery.id);
    }
    
  } catch (error) {
    console.error('Callback query error:', error);
    try {
      await bot.answerCallbackQuery(callbackQuery.id, { 
        text: 'An error occurred. Please try again.', 
        show_alert: true 
      });
    } catch (answerError) {
      console.error('Error answering callback query:', answerError);
    }
  }
});

// Periodic membership check
async function periodicMembershipCheck() {
  try {
    const newUsers = await User.find({
      joinedChannel: false,
      joinedAt: { $gte: new Date(Date.now() - 2 * 60 * 60 * 1000) }
    }).limit(30);
    
    const olderUsers = await User.find({
      joinedChannel: false,
      joinedAt: { $lt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      lastActivity: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    }).limit(20);
    
    const usersToCheck = [...newUsers, ...olderUsers];
    let detectedJoins = 0;
    
    for (const user of usersToCheck) {
      try {
        const isChannelMember = await checkChannelMembership(user.userId);
        
        if (isChannelMember && !user.joinedChannel) {
          detectedJoins++;
          user.joinedChannel = true;
          
          const welcomeKey = `welcome_${user.userId}`;
          if (!welcomeCooldown.has(welcomeKey)) {
            welcomeCooldown.add(welcomeKey);
            
            setTimeout(() => {
              welcomeCooldown.delete(welcomeKey);
            }, 5 * 60 * 1000);
            
            // Count this member toward community progress
            const memberCount = await countMember(user);
            
            if (user.referredBy && user.referralCounted) {
              bot.sendMessage(user.userId, 
                `Welcome to StitchVault community!\n\n` +
                `Your referral has been counted toward our community goal!\n` +
                `Community members: ${memberCount}\n` +
                `Help us unlock more exclusive design collections!\n\n` +
                `Get your invite link: /link\n` +
                `Check community progress: /stats`
              ).catch(() => {});
            } else {
              bot.sendMessage(user.userId, 
                `Welcome to StitchVault!\n\n` +
                `You're now part of our growing community!\n` +
                `Community members: ${memberCount}\n` +
                `Start helping us unlock exclusive designs!\n\n` +
                `Get your invite link: /link\n` +
                `Check community progress: /stats`
              ).catch(() => {});
            }
          }
          
          await user.save();
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        if (error.code !== 400) {
          console.error(`Error checking user ${user.userId}:`, error.message);
        }
      }
    }
    
    if (detectedJoins > 0) {
      await updateStats();
    }
  } catch (error) {
    console.error('Periodic membership check error:', error);
  }
}

// Channel member tracking
bot.on('chat_member', async (chatMember) => {
  if (chatMember.chat.id.toString() !== CHANNEL_ID) return;
  
  const userId = chatMember.new_chat_member.user.id;
  const status = chatMember.new_chat_member.status;
  
  try {
    const user = await User.findOne({ userId });
    if (user) {
      const wasChannelMember = user.joinedChannel;
      
      if (['member', 'administrator', 'creator'].includes(status)) {
        user.joinedChannel = true;
        
        if (!wasChannelMember) {
          const welcomeKey = `welcome_${userId}`;
          if (!welcomeCooldown.has(welcomeKey)) {
            welcomeCooldown.add(welcomeKey);
            
            setTimeout(() => {
              welcomeCooldown.delete(welcomeKey);
            }, 5 * 60 * 1000);
            
            // Count this member toward community progress
            const memberCount = await countMember(user);
            
            if (user.referredBy && user.referralCounted) {
              bot.sendMessage(userId, 
                `Welcome to StitchVault community!\n\n` +
                `Your referral counted toward our community goal!\n` +
                `Community members: ${memberCount}\n` +
                `Help us unlock more exclusive designs!\n\n` +
                `Get your invite link: /link`
              ).catch(() => {});
            } else {
              bot.sendMessage(userId, 
                `Welcome to StitchVault!\n\n` +
                `You're now part of our growing community!\n` +
                `Community members: ${memberCount}\n` +
                `Help us unlock exclusive designs!\n\n` +
                `Get your invite link: /link`
              ).catch(() => {});
            }
          }
        }
      } else if (['left', 'kicked'].includes(status)) {
        user.joinedChannel = false;
        // Decrease community count when someone leaves
        await Stats.findOneAndUpdate(
          {},
          { $inc: { communityMemberCount: -1 } },
          { upsert: true }
        );
      }
      
      await user.save();
    }
  } catch (error) {
    console.error('Chat member update error:', error);
  }
});

// Error handling
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
  
  if (error.code === 'ETELEGRAM' && error.message.includes('409')) {
    console.log('Detected polling conflict - multiple bot instances running');
    console.log('Please stop all other bot instances and restart this one');
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

// Cron jobs
cron.schedule('0 0 * * *', async () => {
  console.log('Running daily tasks...');
  await checkAndSendFallback();
  await updateStats();
});

cron.schedule('*/5 * * * *', async () => {
  await periodicMembershipCheck();
});

console.log(`StitchVault Community Bot started successfully!`);
console.log(`Auto-post interval: ${AUTO_POST_HOURS} hours`);
console.log(`Members per reward: ${INVITES_PER_REWARD}`);
console.log(`Channel: @${CHANNEL_USERNAME}`);
