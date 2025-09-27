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
    console.log('Bot is set up to receive chat member updates in polling mode');
    const botInfo = await bot.getMe();
    console.log(`Bot connected successfully: @${botInfo.username}`);
    console.log(`Make sure bot is added as admin to channel: ${CHANNEL_ID}`);
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

// Enhanced Reward Schema
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

// Channel Post Tracking Schema
const channelPostSchema = new mongoose.Schema({
  postId: { type: String, required: true, unique: true },
  rewardLevel: Number,
  imageMessageId: Number,
  fileMessageId: Number,
  sentAt: { type: Date, default: Date.now },
  communityReferrals: { type: Number, default: 0 }
});

const ChannelPost = mongoose.model('ChannelPost', channelPostSchema);

// UPDATED Stats Schema with community referral count
const statsSchema = new mongoose.Schema({
  totalUsers: { type: Number, default: 0 },
  totalInvites: { type: Number, default: 0 },
  totalRewards: { type: Number, default: 0 },
  channelMembers: { type: Number, default: 0 },
  lastChannelPost: { type: Date, default: null },
  pendingReferrals: { type: Number, default: 0 },
  communityReferralCount: { type: Number, default: 0 }, // NEW: Community-based counter
  lastUpdated: { type: Date, default: Date.now }
});

const Stats = mongoose.model('Stats', statsSchema);

// Helper functions
function generateReferralCode(userId) {
  return `ref_${userId}_${Math.random().toString(36).substring(2, 8)}`;
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

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
      pendingReferrals,
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
    console.error('Channel membership check error:', error);
    return false;
  }
}

async function checkUserBlocked(userId) {
  if (isAdmin(userId)) return false;
  const user = await User.findOne({ userId });
  return user && user.isBlocked;
}

// UPDATED: Function to send content to channel (community-based)
async function sendToChannel(communityCount = 0) {
  try {
    // Calculate which reward level to send based on community count
    const rewardLevel = Math.floor(communityCount / INVITES_PER_REWARD) * INVITES_PER_REWARD;
    
    if (rewardLevel === 0) {
      console.log('No reward level reached yet');
      return;
    }
    
    const imageReward = await Reward.findOne({ level: rewardLevel, isImageFile: true });
    const fileReward = await Reward.findOne({ level: rewardLevel, isImageFile: false });
    
    if (!imageReward && !fileReward) {
      console.log(`No rewards found for level ${rewardLevel}`);
      return;
    }
    
    const postId = `${Date.now()}_${rewardLevel}`;
    let imageMessageId = null;
    let fileMessageId = null;
    
    // Send image first (if available)
    if (imageReward) {
      try {
        const imageMessage = await bot.sendPhoto(CHANNEL_ID, imageReward.imagePath || imageReward.filePath, {
          caption: `🎨 New StitchVault Design Collection!\n\n` +
                  `🏆 Unlocked by our amazing community!\n` +
                  `👥 Community Referrals: ${communityCount}\n` +
                  `🔥 Help us unlock more exclusive designs!\n\n` +
                  `🚀 Join the referral program: https://t.me/${BOT_USERNAME}\n` +
                  `📱 Share StitchVault with friends to unlock premium content!`
        });
        imageMessageId = imageMessage.message_id;
        console.log(`Community image sent to channel for ${communityCount} referrals`);
      } catch (error) {
        console.error('Error sending image to channel:', error);
      }
    }
    
    // Send file second (if available)
    if (fileReward) {
      try {
        const fileMessage = await bot.sendDocument(CHANNEL_ID, fileReward.filePath, {
          caption: `📁 ${fileReward.fileName}\n` +
                  `🎁 Community Reward - Level ${rewardLevel}\n\n` +
                  `🌟 Unlocked by ${communityCount} community referrals!\n` +
                  `💎 Want more exclusive design collections?\n` +
                  `👥 Every 2 referrals unlocks new premium content!\n\n` +
                  `🚀 Start earning: https://t.me/${BOT_USERNAME}\n` +
                  `📢 Share StitchVault and help grow our creative community!`
        });
        fileMessageId = fileMessage.message_id;
        console.log(`Community file sent to channel for ${communityCount} referrals`);
      } catch (error) {
        console.error('Error sending file to channel:', error);
      }
    }
    
    // Track the channel post
    const channelPost = new ChannelPost({
      postId,
      rewardLevel,
      imageMessageId,
      fileMessageId,
      communityReferrals: communityCount
    });
    await channelPost.save();
    
    // Update stats
    await Stats.findOneAndUpdate(
      {},
      { lastChannelPost: new Date() },
      { upsert: true }
    );
    
    return { imageMessageId, fileMessageId };
    
  } catch (error) {
    console.error('Error sending to channel:', error);
  }
}

// UPDATED: Function to check and send fallback content
async function checkAndSendFallback() {
  try {
    const stats = await Stats.findOne();
    const now = new Date();
    const lastPost = stats?.lastChannelPost;
    
    if (!lastPost || (now - lastPost) >= (48 * 60 * 60 * 1000)) {
      console.log('48 hours passed without channel post, sending fallback content...');
      
      const rewards = await Reward.find();
      if (rewards.length > 0) {
        const randomReward = rewards[Math.floor(Math.random() * rewards.length)];
        const currentCount = stats?.communityReferralCount || 0;
        await sendToChannel(currentCount);
        
        // Notify admins
        for (const adminId of ADMIN_IDS) {
          try {
            await bot.sendMessage(adminId, 
              `⏰ Fallback content sent to @${CHANNEL_USERNAME}!\n\n` +
              `📅 Last post was ${lastPost ? Math.floor((now - lastPost) / (1000 * 60 * 60)) : '48+'} hours ago\n` +
              `👥 Community Referrals: ${currentCount}\n` +
              `🎯 Sent Level ${randomReward.level} content`
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

// UPDATED: Community-based referral counting
async function countReferral(user) {
  if (!user.referredBy || user.referralCounted) return;
  
  const referrer = await User.findOne({ userId: user.referredBy });
  if (!referrer) return;
  
  // Count the referral for individual user
  referrer.inviteCount += 1;
  referrer.totalEarned += 1;
  await referrer.save();
  
  // Mark referral as counted
  user.referralCounted = true;
  await user.save();
  
  // UPDATED: Increment community referral count
  const stats = await Stats.findOneAndUpdate(
    {},
    { $inc: { communityReferralCount: 1 } },
    { upsert: true, new: true }
  );
  
  const communityCount = stats.communityReferralCount;
  
  console.log(`Referral counted: User ${user.userId} -> Referrer ${referrer.userId}`);
  console.log(`Community referral count: ${communityCount}`);
  
  // Check if referrer gets individual reward
  const rewardLevel = Math.floor(referrer.inviteCount / INVITES_PER_REWARD) * INVITES_PER_REWARD;
  if (rewardLevel > referrer.lastRewardLevel && rewardLevel > 0) {
    await sendReward(referrer.userId, rewardLevel);
    referrer.lastRewardLevel = rewardLevel;
    await referrer.save();
  }
  
  // UPDATED: Send to channel based on community count every 2 referrals
  if (communityCount % INVITES_PER_REWARD === 0) {
    console.log(`Community milestone reached: ${communityCount} referrals - sending to channel`);
    await sendToChannel(communityCount);
    
    // Notify admins about community milestone
    for (const adminId of ADMIN_IDS) {
      try {
        await bot.sendMessage(adminId, 
          `🎉 Community Milestone Reached!\n\n` +
          `👥 Total Community Referrals: ${communityCount}\n` +
          `👤 Latest Referrer: ${referrer.firstName} (${referrer.userId})\n` +
          `👤 New Member: ${user.firstName} (${user.userId})\n` +
          `📢 Content sent to @${CHANNEL_USERNAME}`
        );
      } catch (error) {
        console.error(`Error notifying admin ${adminId}:`, error);
      }
    }
  }
  
  // Notify referrer with community context
  bot.sendMessage(referrer.userId, 
    `🎉 Referral confirmed! ${user.firstName} joined StitchVault!\n\n` +
    `👤 Your referrals: ${referrer.inviteCount}\n` +
    `🏆 Community total: ${communityCount} referrals\n` +
    `🎯 Next community reward: ${Math.ceil(communityCount / INVITES_PER_REWARD) * INVITES_PER_REWARD} referrals\n\n` +
    `💡 Keep sharing to help unlock more exclusive designs for everyone!`
  ).catch(() => {});
  
  return referrer;
}

// Helper functions for bulk upload
function extractNumberFromFilename(filename) {
  const match = filename.match(/(\d+)/);
  return match ? parseInt(match[1]) : 999;
}

function isImageFileType(filename) {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  const ext = path.extname(filename.toLowerCase());
  return imageExtensions.includes(ext);
}

// Send reward function
async function sendReward(userId, level) {
  try {
    const rewards = await Reward.find({ level });
    if (rewards.length === 0) return;
    
    for (const reward of rewards) {
      await sendRewardFile(userId, reward, `🎉 You've earned a Level ${level} reward for your contributions to StitchVault!`);
    }
  } catch (error) {
    console.error('Send reward error:', error);
  }
}

async function sendRewardFile(userId, reward, message) {
  try {
    await bot.sendMessage(userId, message);
    
    if (reward.isImageFile) {
      await bot.sendPhoto(userId, reward.imagePath || reward.filePath, {
        caption: `🎨 ${reward.fileName}\n🎯 Level: ${reward.level} Preview`
      });
    } else {
      await bot.sendDocument(userId, reward.filePath, {
        caption: `📁 ${reward.fileName}\n🎯 Level: ${reward.level}`
      });
    }
  } catch (error) {
    console.error('Send reward file error:', error);
  }
}

// UPDATED: Start command with StitchVault community messaging
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const referralParam = match[1].trim();
  
  try {
    if (await checkUserBlocked(userId)) {
      return bot.sendMessage(chatId, '🚫 You are temporarily restricted from using this bot. Contact support if needed.');
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
        const referrerCode = referralParam;
        const referrer = await User.findOne({ referralCode: referrerCode });
        
        if (referrer && referrer.userId !== userId) {
          user.referredBy = referrer.userId;
          hasReferrer = true;
          
          bot.sendMessage(referrer.userId, 
            `👤 Someone started the bot through your invite!\n` +
            `📝 They need to join @${CHANNEL_USERNAME} to count toward our community goal.\n` +
            `👥 Your referrals: ${referrer.inviteCount}\n` +
            `🏆 Community progress: Helping unlock exclusive designs!`
          ).catch(() => {});
        }
      }
      
      await user.save();
      await updateStats();
      
      // Send welcome bonus
      if (!user.bonusReceived) {
        const bonusReward = await Reward.findOne({ level: 0 });
        if (bonusReward) {
          await sendRewardFile(userId, bonusReward, "🎁 Welcome to StitchVault! Here's your welcome bonus!");
          user.bonusReceived = true;
          await user.save();
        }
      }
    }
    
    // Get current community stats for welcome message
    const stats = await Stats.findOne() || {};
    const communityCount = stats.communityReferralCount || 0;
    const nextMilestone = Math.ceil(communityCount / INVITES_PER_REWARD) * INVITES_PER_REWARD;
    const needed = nextMilestone - communityCount;
    
    let welcomeMessage;
    
    if (isNewUser && hasReferrer) {
      welcomeMessage = 
        `🎨 Welcome to StitchVault Community!\n\n` +
        `🔥 You were invited to join our creative community!\n` +
        `🎁 You received a welcome bonus design pack!\n\n` +
        `⚠️ **IMPORTANT: Join @${CHANNEL_USERNAME} first to help unlock community designs!**\n\n` +
        `🏆 Community Progress: ${communityCount} referrals\n` +
        `🎯 Next unlock: ${needed} more referrals needed\n` +
        `💡 Every 2 community referrals unlocks exclusive design collections for everyone!\n\n` +
        `🚀 Help grow our creative community and unlock premium content together!`;
    } else if (isNewUser) {
      welcomeMessage = 
        `🎨 Welcome to StitchVault Community!\n\n` +
        `🎁 You received a welcome bonus design pack!\n` +
        `📱 **Join @${CHANNEL_USERNAME} to access our design community!**\n\n` +
        `🏆 Community Progress: ${communityCount} referrals\n` +
        `🎯 Next unlock: ${needed} more referrals needed\n` +
        `💡 Every 2 community referrals unlocks exclusive designs for everyone!\n\n` +
        `🔗 Get your invite link: /link\n` +
        `🚀 Help us grow and unlock amazing design collections together!`;
    } else {
      welcomeMessage = 
        `👋 Welcome back to StitchVault, ${msg.from.first_name}!\n\n` +
        `👤 Your referrals: ${user.inviteCount}\n` +
        `🏆 Community total: ${communityCount} referrals\n` +
        `🎯 Next community unlock: ${needed} more referrals\n\n` +
        `💡 Keep sharing to unlock exclusive designs for our entire community!\n\n` +
        `🔗 Your invite link: /link\n` +
        `📊 Your stats: /stats`;
    }
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '📱 Join StitchVault Channel', url: `https://t.me/${CHANNEL_USERNAME}` }],
        [{ text: '🔗 Get My Invite Link', callback_data: 'get_link' }],
        [{ text: '📊 My Stats & Community Progress', callback_data: 'my_stats' }]
      ]
    };
    
    await bot.sendMessage(chatId, welcomeMessage, { reply_markup: keyboard });
    
  } catch (error) {
    console.error('Start command error:', error);
    bot.sendMessage(chatId, '⚠️ An error occurred. Please try again.');
  }
});

// UPDATED: Link command with community messaging
bot.onText(/\/link/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  try {
    if (await checkUserBlocked(userId)) {
      return bot.sendMessage(chatId, '🚫 You are temporarily restricted from using this bot.');
    }

    await updateUserActivity(userId);
    
    const user = await User.findOne({ userId });
    if (!user) {
      return bot.sendMessage(chatId, '⚠️ Please start the bot first with /start');
    }
    
    const stats = await Stats.findOne() || {};
    const communityCount = stats.communityReferralCount || 0;
    const nextMilestone = Math.ceil(communityCount / INVITES_PER_REWARD) * INVITES_PER_REWARD;
    const needed = nextMilestone - communityCount;
    
    const inviteLink = `https://t.me/${BOT_USERNAME}?start=${user.referralCode}`;
    
    const message = 
      `🔗 Your StitchVault Invite Link:\n` +
      `${inviteLink}\n\n` +
      `👤 Your referrals: ${user.inviteCount}\n` +
      `🏆 Community progress: ${communityCount} total referrals\n` +
      `🎯 Community goal: ${needed} more referrals to unlock new designs\n\n` +
      `💡 Share this link to help our community unlock exclusive design collections!\n` +
      `📱 **Remember: Friends must join @${CHANNEL_USERNAME} to count toward community goals**`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '📤 Share Community Link', url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent('🎨 Join StitchVault creative community! Help us unlock exclusive design collections together! 🚀')}` }],
        [{ text: '📱 Join StitchVault', url: `https://t.me/${CHANNEL_USERNAME}` }]
      ]
    };
    
    await bot.sendMessage(chatId, message, { reply_markup: keyboard });
    
  } catch (error) {
    console.error('Link command error:', error);
    bot.sendMessage(chatId, '⚠️ An error occurred. Please try again.');
  }
});

// FIXED: Bulk upload commands that were missing
bot.onText(/\/bulk_upload/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) {
    return bot.sendMessage(chatId, '❌ You are not authorized to use admin commands.');
  }
  
  const helpMessage = 
    `📦 StitchVault Bulk Upload Instructions:\n\n` +
    `1️⃣ Use /bulk_upload_files to start upload session\n` +
    `2️⃣ Send multiple files/images (they'll auto-sort by name)\n` +
    `3️⃣ Use /bulk_finish when done uploading\n` +
    `4️⃣ Images become preview files, ZIP/RAR become downloads\n\n` +
    `📝 Naming Convention:\n` +
    `• "1.jpg" = Level 2 preview\n` +
    `• "1.zip" = Level 2 download\n` +
    `• "2.png" = Level 4 preview\n` +
    `• "2.rar" = Level 4 download\n\n` +
    `⚡ Quick Commands:\n` +
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
    return bot.sendMessage(chatId, '❌ Not authorized');
  }
  
  bot.sendMessage(chatId, 
    `📤 StitchVault Bulk Upload Started!\n\n` +
    `📁 Send your design files now (images and zips)\n` +
    `⏰ Session expires in 5 minutes\n` +
    `✅ Use /bulk_finish when complete\n` +
    `❌ Use /bulk_cancel to abort`
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
    return bot.sendMessage(chatId, '❌ No active bulk upload session.');
  }
  
  const elapsed = Math.floor((Date.now() - session.startTime) / 1000);
  const remaining = Math.max(0, 300 - elapsed);
  
  const message = 
    `📊 Bulk Upload Status:\n\n` +
    `📁 Files received: ${session.files.length}\n` +
    `⏰ Elapsed: ${elapsed}s\n` +
    `⏳ Remaining: ${remaining}s\n\n` +
    `📋 Recent files:\n` +
    session.files.slice(-5).map(f => `• ${f.fileName}`).join('\n');
  
  await bot.sendMessage(chatId, message);
});

bot.onText(/\/bulk_cancel/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) return;
  
  if (global.bulkUploadSessions?.[userId]) {
    delete global.bulkUploadSessions[userId];
    bot.sendMessage(chatId, '❌ Bulk upload session cancelled.');
  } else {
    bot.sendMessage(chatId, '❌ No active session to cancel.');
  }
});

async function finishBulkUpload(userId) {
  const session = global.bulkUploadSessions?.[userId];
  if (!session) return;
  
  const chatId = session.chatId;
  const files = session.files;
  
  delete global.bulkUploadSessions[userId];
  
  if (files.length === 0) {
    return bot.sendMessage(chatId, '❌ No files received for bulk upload.');
  }
  
  bot.sendMessage(chatId, `🔄 Processing ${files.length} files for StitchVault...`);
  
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
        console.log(`Skipping ${file.fileName} - Level ${level} ${isImageFile ? 'image' : 'file'} exists`);
        continue;
      }
      
      const reward = new Reward({
        rewardId: Date.now() + Math.random() * 1000,
        level: level,
        fileName: file.fileName,
        filePath: file.fileId,
        imageName: isImageFile ? file.fileName : null,
        imagePath: isImageFile ? file.fileId : null,
        description: `StitchVault Level ${level} ${isImageFile ? 'preview' : 'download'}`,
        addedBy: userId,
        isImageFile: isImageFile,
        originalOrder: fileNumber
      });
      
      await reward.save();
      processed++;
      
    } catch (error) {
      console.error(`Error processing file ${file.fileName}:`, error);
      errors++;
    }
  }
  
  const resultMessage = 
    `✅ StitchVault Bulk Upload Complete!\n\n` +
    `📁 Processed: ${processed}\n` +
    `❌ Errors: ${errors}\n` +
    `📊 Total received: ${files.length}\n\n` +
    `🎯 Reward levels created: ${files.map(f => extractNumberFromFilename(f.fileName) * INVITES_PER_REWARD).join(', ')}`;
  
  await bot.sendMessage(chatId, resultMessage);
  await updateStats();
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
    `📁 File added: ${file.fileName}\n` +
    `📊 Total files: ${session.files.length}\n` +
    `⏰ Send more or /bulk_finish when done`
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
    `🖼️ Image added: ${fileName}\n` +
    `📊 Total files: ${session.files.length}\n` +
    `⏰ Send more or /bulk_finish when done`
  );
});

// UPDATED: Stats command with community progress
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  try {
    if (await checkUserBlocked(userId)) {
      return bot.sendMessage(chatId, '🚫 You are temporarily restricted from using this bot.');
    }

    await updateUserActivity(userId);
    
    const user = await User.findOne({ userId });
    if (!user) {
      return bot.sendMessage(chatId, '⚠️ Please start the bot first with /start');
    }
    
    await checkAndUpdateMembership(userId);
    const updatedUser = await User.findOne({ userId });
    const stats = await Stats.findOne() || {};
    
    const communityCount = stats.communityReferralCount || 0;
    const nextCommunityMilestone = Math.ceil(communityCount / INVITES_PER_REWARD) * INVITES_PER_REWARD;
    const communityNeeded = nextCommunityMilestone - communityCount;
    
    const userNextReward = Math.ceil(updatedUser.inviteCount / INVITES_PER_REWARD) * INVITES_PER_REWARD;
    const userProgress = updatedUser.inviteCount % INVITES_PER_REWARD;
    const userNeeded = INVITES_PER_REWARD - userProgress;
    
    let referralStatus = '';
    if (updatedUser.referredBy && !updatedUser.referralCounted) {
      referralStatus = `\n🔥 Pending referral (join @${CHANNEL_USERNAME} to activate)`;
    } else if (updatedUser.referredBy && updatedUser.referralCounted) {
      referralStatus = `\n✅ Referral counted toward community goal`;
    }
    
    const message = 
      `📊 StitchVault Community Stats:\n\n` +
      `👤 Your Profile:\n` +
      `• Name: ${updatedUser.firstName} ${updatedUser.lastName || ''}\n` +
      `• Joined: ${updatedUser.joinedAt.toDateString()}\n` +
      `• Channel Member: ${updatedUser.joinedChannel ? '✅' : '❌'}${referralStatus}\n\n` +
      `🎯 Your Contributions:\n` +
      `• Your referrals: ${updatedUser.inviteCount}\n` +
      `• Your next reward: ${userNeeded} more referrals\n` +
      `• Total earned: ${updatedUser.totalEarned}\n\n` +
      `🏆 Community Progress:\n` +
      `• Total community referrals: ${communityCount}\n` +
      `• Next community unlock: ${communityNeeded} more referrals\n` +
      `• Last content shared: ${stats.lastChannelPost ? stats.lastChannelPost.toDateString() : 'Never'}\n\n` +
      `💡 Every 2 community referrals unlocks exclusive designs for everyone!`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '🔗 Get Invite Link', callback_data: 'get_link' }],
        [{ text: '📱 Join StitchVault', url: `https://t.me/${CHANNEL_USERNAME}` }]
      ]
    };
    
    await bot.sendMessage(chatId, message, { reply_markup: keyboard });
    
  } catch (error) {
    console.error('Stats command error:', error);
    bot.sendMessage(chatId, '⚠️ An error occurred. Please try again.');
  }
});

// Periodic membership check
async function periodicMembershipCheck() {
  try {
    console.log('Running periodic membership check...');
    
    const newUsersToCheck = await User.find({
      joinedChannel: false,
      joinedAt: { $gte: new Date(Date.now() - 2 * 60 * 60 * 1000) }
    }).limit(30);
    
    const olderUsersToCheck = await User.find({
      joinedChannel: false,
      joinedAt: { $lt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      lastActivity: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    }).limit(20);
    
    const usersToCheck = [...newUsersToCheck, ...olderUsersToCheck];
    let detectedJoins = 0;
    
    for (const user of usersToCheck) {
      try {
        const isChannelMember = await checkChannelMembership(user.userId);
        
        if (isChannelMember && !user.joinedChannel) {
          console.log(`Detected new channel member: ${user.firstName} (${user.userId})`);
          detectedJoins++;
          
          user.joinedChannel = true;
          
          if (user.referredBy && !user.referralCounted) {
            const referrer = await countReferral(user);
            
            if (referrer) {
              bot.sendMessage(user.userId, 
                `🎉 Welcome to StitchVault community!\n\n` +
                `✅ Your referral has been counted toward our community goal!\n` +
                `🎨 Help us unlock more exclusive design collections!\n\n` +
                `🔗 Get your invite link: /link\n` +
                `📊 Check community progress: /stats`
              ).catch(() => {});
            }
          } else {
            bot.sendMessage(user.userId, 
              `🎉 Welcome to StitchVault!\n\n` +
              `🎨 Start helping our community unlock exclusive designs!\n\n` +
              `🔗 Get your invite link: /link\n` +
              `📊 Check community progress: /stats`
            ).catch(() => {});
          }
          
          await user.save();
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        if (error.code === 400 && error.description?.includes('USER_NOT_FOUND')) {
          console.log(`User ${user.userId} not found, skipping...`);
        } else {
          console.error(`Error checking membership for user ${user.userId}:`, error.message);
        }
      }
    }
    
    if (detectedJoins > 0) {
      console.log(`Detected ${detectedJoins} new channel joins`);
      await updateStats();
    }
  } catch (error) {
    console.error('Periodic membership check error:', error);
  }
}

async function checkAndUpdateMembership(userId) {
  try {
    const user = await User.findOne({ userId });
    if (!user) return false;
    
    const isChannelMember = await checkChannelMembership(userId);
    const wasChannelMember = user.joinedChannel;
    
    if (isChannelMember !== wasChannelMember) {
      user.joinedChannel = isChannelMember;
      
      if (isChannelMember && !wasChannelMember) {
        console.log(`User ${userId} joined channel`);
        
        if (user.referredBy && !user.referralCounted) {
          await countReferral(user);
        }
      }
      
      await user.save();
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('Error checking membership:', error);
    return false;
  }
}

// Admin commands
bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) {
    return bot.sendMessage(chatId, '❌ You are not authorized to use admin commands.');
  }
  
  const adminHelp = 
    `👨‍💼 StitchVault Admin Commands:\n\n` +
    `📊 Analytics:\n` +
    `/stats_admin - Bot & community statistics\n` +
    `/users - List all users\n` +
    `/user <id> - Get user details\n\n` +
    `🎁 Content Management:\n` +
    `/reward <level> - Add single reward\n` +
    `/bulk_upload - Bulk upload instructions\n` +
    `/bulk_upload_files - Start bulk session\n` +
    `/rewards - List all rewards\n` +
    `/delete_reward <id> - Delete reward\n\n` +
    `📢 Channel Management:\n` +
    `/send_channel - Manual community post\n` +
    `/test_channel <level> - Test channel post\n` +
    `/channel_history - View post history\n\n` +
    `👥 User Management:\n` +
    `/broadcast <message> - Message all users\n` +
    `/block <id> - Block user\n` +
    `/unblock <id> - Unblock user\n` +
    `/reset_community - Reset community counter\n` +
    `/backup - Download database`;
  
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
    const communityCount = stats.communityReferralCount || 0;
    
    const message = 
      `📊 StitchVault Admin Statistics:\n\n` +
      `👥 Users:\n` +
      `• Total: ${totalUsers}\n` +
      `• Active (7d): ${activeUsers}\n` +
      `• Channel members: ${channelMembers}\n` +
      `• Pending referrals: ${pendingReferrals}\n\n` +
      `🏆 Community Progress:\n` +
      `• Community referrals: ${communityCount}\n` +
      `• Individual referrals: ${totalInvites[0]?.total || 0}\n` +
      `• Next milestone: ${Math.ceil(communityCount / INVITES_PER_REWARD) * INVITES_PER_REWARD}\n\n` +
      `🎁 Content:\n` +
      `• Total rewards: ${totalRewards}\n` +
      `• Channel posts: ${channelPosts}\n` +
      `• Last post: ${stats.lastChannelPost ? stats.lastChannelPost.toLocaleString() : 'Never'}\n\n` +
      `📅 Updated: ${new Date().toLocaleString()}`;
    
    await bot.sendMessage(chatId, message);
    
  } catch (error) {
    console.error('Admin stats error:', error);
    bot.sendMessage(chatId, '❌ Error fetching statistics.');
  }
});

// Reset community counter command
bot.onText(/\/reset_community/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) return;
  
  try {
    await Stats.findOneAndUpdate(
      {},
      { communityReferralCount: 0 },
      { upsert: true }
    );
    
    bot.sendMessage(chatId, '🔄 Community referral counter has been reset to 0.');
    
  } catch (error) {
    console.error('Reset community error:', error);
    bot.sendMessage(chatId, '❌ Error resetting community counter.');
  }
});

// Manual community post
bot.onText(/\/send_channel/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) return;
  
  try {
    const stats = await Stats.findOne() || {};
    const communityCount = stats.communityReferralCount || 0;
    
    const result = await sendToChannel(communityCount);
    
    if (result) {
      bot.sendMessage(chatId, 
        `✅ Community content sent to @${CHANNEL_USERNAME}!\n\n` +
        `👥 Community referrals: ${communityCount}\n` +
        `🖼️ Image: ${result.imageMessageId ? '✅' : '❌'}\n` +
        `📁 File: ${result.fileMessageId ? '✅' : '❌'}`
      );
    } else {
      bot.sendMessage(chatId, '❌ No content available to send.');
    }
    
  } catch (error) {
    console.error('Manual send error:', error);
    bot.sendMessage(chatId, '❌ Error sending to channel.');
  }
});

// Callback query handler
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
      const communityCount = stats.communityReferralCount || 0;
      const nextMilestone = Math.ceil(communityCount / INVITES_PER_REWARD) * INVITES_PER_REWARD;
      const needed = nextMilestone - communityCount;
      
      const inviteLink = `https://t.me/${BOT_USERNAME}?start=${user.referralCode}`;
      
      const message = 
        `🔗 Your StitchVault Community Link:\n` +
        `${inviteLink}\n\n` +
        `👤 Your referrals: ${user.inviteCount}\n` +
        `🏆 Community progress: ${communityCount} referrals\n` +
        `🎯 Next unlock: ${needed} more referrals\n\n` +
        `💡 Share to help unlock exclusive designs for everyone!\n` +
        `📱 Friends must join @${CHANNEL_USERNAME} to count`;
      
      const keyboard = {
        inline_keyboard: [
          [{ text: '📤 Share Community Link', url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent('🎨 Join StitchVault! Help unlock exclusive design collections! 🚀')}` }],
          [{ text: '📱 Join StitchVault', url: `https://t.me/${CHANNEL_USERNAME}` }]
        ]
      };
      
      await bot.sendMessage(chatId, message, { reply_markup: keyboard });
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Here\'s your community invite link!' });
      
    } else if (data === 'my_stats') {
      bot.emit('message', { 
        chat: { id: chatId }, 
        from: callbackQuery.from, 
        text: '/stats' 
      });
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

// Channel member tracking
bot.on('chat_member', async (chatMember) => {
  if (chatMember.chat.id.toString() !== CHANNEL_ID) return;
  
  const userId = chatMember.new_chat_member.user.id;
  const status = chatMember.new_chat_member.status;
  
  console.log(`Chat member update: User ${userId}, Status: ${status}`);
  
  try {
    const user = await User.findOne({ userId });
    if (user) {
      const wasChannelMember = user.joinedChannel;
      
      if (['member', 'administrator', 'creator'].includes(status)) {
        user.joinedChannel = true;
        
        if (!wasChannelMember && user.referredBy && !user.referralCounted) {
          await countReferral(user);
          
          bot.sendMessage(userId, 
            `🎉 Welcome to StitchVault community!\n\n` +
            `✅ Your referral counted toward our community goal!\n` +
            `🎨 Help us unlock more exclusive designs!\n\n` +
            `🔗 Get your invite link: /link`
          ).catch(() => {});
        } else if (!wasChannelMember) {
          bot.sendMessage(userId, 
            `🎉 Welcome to StitchVault!\n\n` +
            `🎨 Help our community unlock exclusive designs!\n\n` +
            `🔗 Get your invite link: /link`
          ).catch(() => {});
        }
      } else if (['left', 'kicked'].includes(status)) {
        user.joinedChannel = false;
      }
      
      await user.save();
    }
  } catch (error) {
    console.error('Chat member update error:', error);
  }
});

// Error handling
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Cron jobs
cron.schedule('0 0 * * *', async () => {
  console.log('Running daily fallback check...');
  await checkAndSendFallback();
  await updateStats();
});

cron.schedule('*/5 * * * *', async () => {
  await periodicMembershipCheck();
});

console.log('StitchVault Community Bot with fixed bulk upload started successfully!');
