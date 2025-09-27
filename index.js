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

// Initialize bot with conflict handling
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

// Stats Schema with community referral count
const statsSchema = new mongoose.Schema({
  totalUsers: { type: Number, default: 0 },
  totalInvites: { type: Number, default: 0 },
  totalRewards: { type: Number, default: 0 },
  channelMembers: { type: Number, default: 0 },
  lastChannelPost: { type: Date, default: null },
  pendingReferrals: { type: Number, default: 0 },
  communityReferralCount: { type: Number, default: 0 },
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
    return false;
  }
}

async function checkUserBlocked(userId) {
  if (isAdmin(userId)) return false;
  const user = await User.findOne({ userId });
  return user && user.isBlocked;
}

// Send to channel function (community-based)
async function sendToChannel(communityCount = 0) {
  try {
    const rewardLevel = Math.floor(communityCount / INVITES_PER_REWARD) * INVITES_PER_REWARD;
    
    if (rewardLevel === 0) return;
    
    const imageReward = await Reward.findOne({ level: rewardLevel, isImageFile: true });
    const fileReward = await Reward.findOne({ level: rewardLevel, isImageFile: false });
    
    if (!imageReward && !fileReward) return;
    
    const postId = `${Date.now()}_${rewardLevel}`;
    let imageMessageId = null;
    let fileMessageId = null;
    
    // Send image first (no caption)
    if (imageReward) {
      try {
        const imageMessage = await bot.sendPhoto(CHANNEL_ID, imageReward.imagePath || imageReward.filePath);
        imageMessageId = imageMessage.message_id;
        results.push(`🖼️ Image sent: ${imageReward.fileName}`);
      } catch (error) {
        results.push(`❌ Image failed: ${error.message}`);
      }
    }
    
    if (fileReward) {
      try {
        const fileMessage = await bot.sendDocument(CHANNEL_ID, fileReward.filePath);
        fileMessageId = fileMessage.message_id;
        results.push(`📁 File sent: ${fileReward.fileName}`);
      } catch (error) {
        results.push(`❌ File failed: ${error.message}`);
      }
    }
    
    // Track the post
    if (imageMessageId || fileMessageId) {
      const channelPost = new ChannelPost({
        postId: `${Date.now()}_${level}`,
        rewardLevel: level,
        imageMessageId,
        fileMessageId,
        communityReferrals: 0
      });
      await channelPost.save();
    }
    
    bot.sendMessage(chatId, 
      `📢 Manual Channel Post Results:\n\n` +
      results.join('\n') +
      `\n\n📱 Channel: @${CHANNEL_USERNAME}`
    );
    
  } catch (error) {
    console.error('Send channel error:', error);
    bot.sendMessage(chatId, `❌ Error: ${error.message}`);
  }
});

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
    `📊 Total: ${session.files.length} files\n` +
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
    `📊 Total: ${session.files.length} files\n` +
    `⏰ Send more or /bulk_finish when done`
  );
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
        `🔗 Your StitchVault Link:\n` +
        `${inviteLink}\n\n` +
        `👤 Your referrals: ${user.inviteCount}\n` +
        `🏆 Community: ${communityCount} referrals\n` +
        `🎯 Next unlock: ${needed} more referrals\n\n` +
        `💡 Share to unlock exclusive designs!\n` +
        `📱 Friends must join @${CHANNEL_USERNAME}`;
      
      const keyboard = {
        inline_keyboard: [
          [{ text: '📤 Share Link', url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent('Join StitchVault creative community! 🎨')}` }],
          [{ text: '📱 Join Channel', url: `https://t.me/${CHANNEL_USERNAME}` }]
        ]
      };
      
      await bot.sendMessage(chatId, message, { reply_markup: keyboard });
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Here is your invite link!' });
      
    } else if (data === 'my_stats') {
      bot.emit('message', { 
        chat: { id: chatId }, 
        from: callbackQuery.from, 
        text: '/stats' 
      });
      await bot.answerCallbackQuery(callbackQuery.id);
      
    } else if (data === 'help') {
      bot.emit('message', { 
        chat: { id: chatId }, 
        from: callbackQuery.from, 
        text: '/help' 
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
          
          // Only send welcome if not in cooldown
          const welcomeKey = `welcome_${user.userId}`;
          if (!welcomeCooldown.has(welcomeKey)) {
            welcomeCooldown.add(welcomeKey);
            
            // Remove from cooldown after 10 minutes
            setTimeout(() => {
              welcomeCooldown.delete(welcomeKey);
            }, 10 * 60 * 1000);
            
            if (user.referredBy && !user.referralCounted) {
              await countReferral(user);
              
              bot.sendMessage(user.userId, 
                `🎉 Welcome to StitchVault!\n\n` +
                `✅ Your referral counted toward community goals!\n` +
                `🎨 Help unlock more exclusive designs!\n\n` +
                `🔗 Get your invite link: /link`
              ).catch(() => {});
            } else {
              bot.sendMessage(user.userId, 
                `🎉 Welcome to StitchVault!\n\n` +
                `🎨 Help our community unlock exclusive designs!\n\n` +
                `🔗 Get your invite link: /link`
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
            }, 10 * 60 * 1000);
            
            if (user.referredBy && !user.referralCounted) {
              await countReferral(user);
              
              bot.sendMessage(userId, 
                `🎉 Welcome to StitchVault!\n\n` +
                `✅ Your referral counted!\n` +
                `🎨 Help unlock more designs!\n\n` +
                `🔗 Get your link: /link`
              ).catch(() => {});
            } else {
              bot.sendMessage(userId, 
                `🎉 Welcome to StitchVault!\n\n` +
                `🎨 Help unlock exclusive designs!\n\n` +
                `🔗 Get your link: /link`
              ).catch(() => {});
            }
          }
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
  await updateStats();
});

cron.schedule('*/5 * * * *', async () => {
  await periodicMembershipCheck();
});

console.log('StitchVault Community Bot started successfully!');id;
      } catch (error) {
        console.error('Error sending image:', error);
      }
    }
    
    // Send file second (no caption)
    if (fileReward) {
      try {
        const fileMessage = await bot.sendDocument(CHANNEL_ID, fileReward.filePath);
        fileMessageId = fileMessage.message_id;
      } catch (error) {
        console.error('Error sending file:', error);
      }
    }
    
    // Track the post
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

// Community-based referral counting
async function countReferral(user) {
  if (!user.referredBy || user.referralCounted) return;
  
  const referrer = await User.findOne({ userId: user.referredBy });
  if (!referrer) return;
  
  // Count individual referral
  referrer.inviteCount += 1;
  referrer.totalEarned += 1;
  await referrer.save();
  
  // Mark referral as counted
  user.referralCounted = true;
  await user.save();
  
  // Update community count
  const stats = await Stats.findOneAndUpdate(
    {},
    { $inc: { communityReferralCount: 1 } },
    { upsert: true, new: true }
  );
  
  const communityCount = stats.communityReferralCount;
  
  // Check individual reward
  const rewardLevel = Math.floor(referrer.inviteCount / INVITES_PER_REWARD) * INVITES_PER_REWARD;
  if (rewardLevel > referrer.lastRewardLevel && rewardLevel > 0) {
    await sendReward(referrer.userId, rewardLevel);
    referrer.lastRewardLevel = rewardLevel;
    await referrer.save();
  }
  
  // Community milestone reached
  if (communityCount % INVITES_PER_REWARD === 0) {
    await sendToChannel(communityCount);
    
    // Notify admins
    for (const adminId of ADMIN_IDS) {
      try {
        await bot.sendMessage(adminId, 
          `🎉 Community Milestone!\n\n` +
          `👥 Total referrals: ${communityCount}\n` +
          `👤 Latest: ${user.firstName} via ${referrer.firstName}\n` +
          `📢 Content sent to @${CHANNEL_USERNAME}`
        );
      } catch (error) {
        console.error(`Error notifying admin:`, error);
      }
    }
  }
  
  // Notify referrer
  bot.sendMessage(referrer.userId, 
    `🎉 Referral confirmed! ${user.firstName} joined StitchVault!\n\n` +
    `👤 Your referrals: ${referrer.inviteCount}\n` +
    `🏆 Community total: ${communityCount}\n` +
    `🎯 Next milestone: ${Math.ceil(communityCount / INVITES_PER_REWARD) * INVITES_PER_REWARD} referrals`
  ).catch(() => {});
  
  return referrer;
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

async function finishBulkUpload(userId) {
  const session = global.bulkUploadSessions?.[userId];
  if (!session) return;
  
  const chatId = session.chatId;
  const files = session.files;
  
  delete global.bulkUploadSessions[userId];
  
  if (files.length === 0) {
    return bot.sendMessage(chatId, '❌ No files received for bulk upload.');
  }
  
  bot.sendMessage(chatId, `🔄 Processing ${files.length} files...`);
  
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
    `✅ Bulk Upload Complete!\n\n` +
    `📁 Processed: ${processed}\n` +
    `❌ Errors: ${errors}\n` +
    `📊 Total: ${files.length}`;
  
  await bot.sendMessage(chatId, resultMessage);
  await updateStats();
}

// Send reward function
async function sendReward(userId, level) {
  try {
    const rewards = await Reward.find({ level });
    if (rewards.length === 0) return;
    
    for (const reward of rewards) {
      await sendRewardFile(userId, reward, `🎉 Level ${level} reward unlocked!`);
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
        caption: `🎨 ${reward.fileName} - Level ${reward.level}`
      });
    } else {
      await bot.sendDocument(userId, reward.filePath, {
        caption: `📁 ${reward.fileName} - Level ${reward.level}`
      });
    }
  } catch (error) {
    console.error('Send reward file error:', error);
  }
}

// BOT COMMANDS

// Start command
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const referralParam = match[1].trim();
  
  try {
    if (await checkUserBlocked(userId)) {
      return bot.sendMessage(chatId, '🚫 You are temporarily restricted from using this bot.');
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
            `👤 Someone started the bot through your invite!\n` +
            `📝 They need to join @${CHANNEL_USERNAME} to help reach community goals.\n` +
            `👥 Your referrals: ${referrer.inviteCount}`
          ).catch(() => {});
        }
      }
      
      await user.save();
      await updateStats();
      
      // Send welcome bonus
      if (!user.bonusReceived) {
        const bonusReward = await Reward.findOne({ level: 0 });
        if (bonusReward) {
          await sendRewardFile(userId, bonusReward, "🎁 Welcome to StitchVault!");
          user.bonusReceived = true;
          await user.save();
        }
      }
    }
    
    // Get community stats
    const stats = await Stats.findOne() || {};
    const communityCount = stats.communityReferralCount || 0;
    const nextMilestone = Math.ceil(communityCount / INVITES_PER_REWARD) * INVITES_PER_REWARD;
    const needed = nextMilestone - communityCount;
    
    let welcomeMessage;
    
    if (isNewUser && hasReferrer) {
      welcomeMessage = 
        `🎨 Welcome to StitchVault Community!\n\n` +
        `🔥 You were invited to join our creative community!\n` +
        `🎁 You received a welcome bonus!\n\n` +
        `⚠️ **Join @${CHANNEL_USERNAME} to help unlock community designs!**\n\n` +
        `🏆 Community Progress: ${communityCount} referrals\n` +
        `🎯 Next unlock: ${needed} more referrals needed\n\n` +
        `💡 Every ${INVITES_PER_REWARD} community referrals unlocks exclusive content for everyone!`;
    } else if (isNewUser) {
      welcomeMessage = 
        `🎨 Welcome to StitchVault Community!\n\n` +
        `🎁 You received a welcome bonus!\n` +
        `📱 **Join @${CHANNEL_USERNAME} to access our design community!**\n\n` +
        `🏆 Community Progress: ${communityCount} referrals\n` +
        `🎯 Next unlock: ${needed} more needed\n\n` +
        `🔗 Get your invite link: /link\n` +
        `❓ Need help: /help`;
    } else {
      welcomeMessage = 
        `👋 Welcome back to StitchVault, ${msg.from.first_name}!\n\n` +
        `👤 Your referrals: ${user.inviteCount}\n` +
        `🏆 Community total: ${communityCount}\n` +
        `🎯 Next unlock: ${needed} more referrals\n\n` +
        `🔗 Your invite link: /link\n` +
        `📊 Your stats: /stats`;
    }
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '📱 Join StitchVault', url: `https://t.me/${CHANNEL_USERNAME}` }],
        [{ text: '🔗 Get Invite Link', callback_data: 'get_link' }],
        [{ text: '📊 My Stats', callback_data: 'my_stats' }],
        [{ text: '❓ Help', callback_data: 'help' }]
      ]
    };
    
    await bot.sendMessage(chatId, welcomeMessage, { reply_markup: keyboard });
    
  } catch (error) {
    console.error('Start command error:', error);
    bot.sendMessage(chatId, '⚠️ An error occurred. Please try again.');
  }
});

// Link command
bot.onText(/\/link/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  try {
    if (await checkUserBlocked(userId)) {
      return bot.sendMessage(chatId, '🚫 You are restricted from using this bot.');
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
      `🏆 Community progress: ${communityCount} referrals\n` +
      `🎯 Community goal: ${needed} more to unlock designs\n\n` +
      `💡 Share to help unlock exclusive collections!\n` +
      `📱 Friends must join @${CHANNEL_USERNAME} to count`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '📤 Share Link', url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent('🎨 Join StitchVault creative community! 🚀')}` }],
        [{ text: '📱 Join Channel', url: `https://t.me/${CHANNEL_USERNAME}` }]
      ]
    };
    
    await bot.sendMessage(chatId, message, { reply_markup: keyboard });
    
  } catch (error) {
    console.error('Link command error:', error);
    bot.sendMessage(chatId, '⚠️ An error occurred.');
  }
});

// Stats command
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  try {
    if (await checkUserBlocked(userId)) {
      return bot.sendMessage(chatId, '🚫 You are restricted from using this bot.');
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
    
    const userNext = Math.ceil(user.inviteCount / INVITES_PER_REWARD) * INVITES_PER_REWARD;
    const userNeeded = userNext - user.inviteCount;
    
    let referralStatus = '';
    if (user.referredBy && !user.referralCounted) {
      referralStatus = `\n🔥 Pending referral (join @${CHANNEL_USERNAME} to activate)`;
    } else if (user.referredBy && user.referralCounted) {
      referralStatus = `\n✅ Referral counted`;
    }
    
    const message = 
      `📊 StitchVault Stats:\n\n` +
      `👤 Your Profile:\n` +
      `• Name: ${user.firstName} ${user.lastName || ''}\n` +
      `• Joined: ${user.joinedAt.toDateString()}\n` +
      `• Channel Member: ${user.joinedChannel ? '✅' : '❌'}${referralStatus}\n\n` +
      `🎯 Your Progress:\n` +
      `• Your referrals: ${user.inviteCount}\n` +
      `• Next personal reward: ${userNeeded} more referrals\n` +
      `• Total earned: ${user.totalEarned}\n\n` +
      `🏆 Community Progress:\n` +
      `• Total referrals: ${communityCount}\n` +
      `• Next unlock: ${needed} more referrals\n` +
      `• Last content: ${stats.lastChannelPost ? stats.lastChannelPost.toDateString() : 'None yet'}\n\n` +
      `💡 Every ${INVITES_PER_REWARD} community referrals = new exclusive content!`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '🔗 Get Invite Link', callback_data: 'get_link' }],
        [{ text: '📱 Join Channel', url: `https://t.me/${CHANNEL_USERNAME}` }]
      ]
    };
    
    await bot.sendMessage(chatId, message, { reply_markup: keyboard });
    
  } catch (error) {
    console.error('Stats command error:', error);
    bot.sendMessage(chatId, '⚠️ An error occurred.');
  }
});

// Help command
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  
  const helpMessage = 
    `❓ StitchVault Community Help\n\n` +
    `🎨 How it works:\n` +
    `1. Get your invite link with /link\n` +
    `2. Share with friends\n` +
    `3. Friends must join @${CHANNEL_USERNAME}\n` +
    `4. Every ${INVITES_PER_REWARD} community referrals unlock exclusive content!\n\n` +
    `🤖 Commands:\n` +
    `/start - Start the bot\n` +
    `/link - Get your invite link\n` +
    `/stats - View your statistics\n` +
    `/help - Show this help\n\n` +
    `🎁 Rewards:\n` +
    `• Welcome bonus on first start\n` +
    `• Personal rewards for your referrals\n` +
    `• Community unlocks exclusive content for everyone\n\n` +
    `📞 Need support? Contact our admins!`;
  
  const keyboard = {
    inline_keyboard: [
      [{ text: '📱 Join StitchVault', url: `https://t.me/${CHANNEL_USERNAME}` }],
      [{ text: '🔗 Get Invite Link', callback_data: 'get_link' }]
    ]
  };
  
  await bot.sendMessage(chatId, helpMessage, { reply_markup: keyboard });
});

// ADMIN COMMANDS

bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) {
    return bot.sendMessage(chatId, '❌ Not authorized.');
  }
  
  const adminHelp = 
    `👨‍💼 StitchVault Admin Commands:\n\n` +
    `📊 Analytics:\n` +
    `/stats_admin - Bot statistics\n` +
    `/users - List users\n` +
    `/user <id> - User details\n\n` +
    `🎁 Content:\n` +
    `/reward <level> - Add single reward\n` +
    `/bulk_upload - Bulk upload help\n` +
    `/bulk_upload_files - Start bulk upload\n` +
    `/rewards - List rewards\n` +
    `/delete_reward <id> - Delete reward\n\n` +
    `📢 Channel:\n` +
    `/send_channel <level> - Manual post\n` +
    `/channel_history - Post history\n` +
    `/test_channel <level> - Test post\n\n` +
    `👥 Users:\n` +
    `/broadcast <msg> - Message all\n` +
    `/block <id> - Block user\n` +
    `/unblock <id> - Unblock user\n` +
    `/reset_community - Reset counter\n` +
    `/backup - Download backup`;
  
  await bot.sendMessage(chatId, adminHelp);
});

bot.onText(/\/bulk_upload_files/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) {
    return bot.sendMessage(chatId, '❌ Not authorized');
  }
  
  bot.sendMessage(chatId, 
    `📤 Bulk Upload Session Started!\n\n` +
    `📁 Send files now (images and documents)\n` +
    `⏰ Session expires in 5 minutes\n` +
    `✅ Use /bulk_finish when complete`
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

bot.onText(/\/send_channel (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const level = parseInt(match[1]);
  
  if (!isAdmin(userId)) return;
  
  try {
    const imageReward = await Reward.findOne({ level, isImageFile: true });
    const fileReward = await Reward.findOne({ level, isImageFile: false });
    
    if (!imageReward && !fileReward) {
      return bot.sendMessage(chatId, `❌ No rewards found for level ${level}`);
    }
    
    let results = [];
    let imageMessageId = null;
    let fileMessageId = null;
    
    if (imageReward) {
      try {
        const imageMessage = await bot.sendPhoto(CHANNEL_ID, imageReward.imagePath || imageReward.filePath);
        imageMessageId = imageMessage.message_
