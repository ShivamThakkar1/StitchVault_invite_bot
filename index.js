require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

// Initialize Express for health checks (required for Render)
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('StitchVault Rewards Bot is running!');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const CHANNEL_ID = process.env.CHANNEL_ID; // @stitchvault channel ID
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || 'stitchvault';
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id)) : [];
const INVITES_PER_REWARD = parseInt(process.env.INVITES_PER_REWARD) || 2; // Changed to 2
const BOT_USERNAME = process.env.BOT_USERNAME || 'StitchVaultBot';

// Initialize bot with webhook settings to receive chat_member updates
const bot = new TelegramBot(BOT_TOKEN, { 
  polling: {
    interval: 1000,
    autoStart: true,
    params: {
      timeout: 10,
      allowed_updates: ['message', 'callback_query', 'chat_member', 'my_chat_member']
    }
  }
});

// MongoDB connection
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    setupChatMemberUpdates();
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
  });

// Function to enable chat member updates
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

// UPDATED User Schema
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
  bonusReceived: { type: Boolean, default: false },
  dailyStreak: { type: Number, default: 0 },
  lastDaily: Date,
  lastWeekInvites: { type: Number, default: 0 }
});

const User = mongoose.model('User', userSchema);

// ENHANCED Reward Schema with image and file support
const rewardSchema = new mongoose.Schema({
  rewardId: { type: Number, required: true, unique: true },
  level: { type: Number, required: true },
  fileName: String,
  filePath: String, // For zip files
  imageName: String,
  imagePath: String, // For preview images
  description: String,
  addedBy: Number,
  addedAt: { type: Date, default: Date.now },
  isImageFile: { type: Boolean, default: false }, // To distinguish between image and zip rewards
  originalOrder: Number // For bulk upload ordering
});

const Reward = mongoose.model('Reward', rewardSchema);

// NEW: Channel Post Tracking Schema
const channelPostSchema = new mongoose.Schema({
  postId: { type: String, required: true, unique: true },
  rewardLevel: Number,
  imageMessageId: Number,
  fileMessageId: Number,
  sentAt: { type: Date, default: Date.now },
  referralCount: { type: Number, default: 0 } // Track how many referrals triggered this post
});

const ChannelPost = mongoose.model('ChannelPost', channelPostSchema);

// Stats Schema
const statsSchema = new mongoose.Schema({
  totalUsers: { type: Number, default: 0 },
  totalInvites: { type: Number, default: 0 },
  totalRewards: { type: Number, default: 0 },
  channelMembers: { type: Number, default: 0 },
  lastChannelPost: { type: Date, default: null },
  pendingReferrals: { type: Number, default: 0 },
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

// Check if user is member of channel
async function checkChannelMembership(userId) {
  try {
    const member = await bot.getChatMember(CHANNEL_ID, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (error) {
    console.error('Channel membership check error:', error);
    return false;
  }
}

// Middleware to check if user is blocked
async function checkUserBlocked(userId) {
  if (isAdmin(userId)) return false;
  const user = await User.findOne({ userId });
  return user && user.isBlocked;
}

// NEW: Function to send content to channel
async function sendToChannel(rewardLevel, triggerReferrals = 0) {
  try {
    // Get both image and file rewards for this level
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
          caption: `🎨 New StitchVault Collection Preview!\n\n📦 Level ${rewardLevel} Reward\n🔥 Get yours by inviting ${INVITES_PER_REWARD} friends!\n\n🔗 Start here: https://t.me/${BOT_USERNAME}`
        });
        imageMessageId = imageMessage.message_id;
        console.log(`Image sent to channel for level ${rewardLevel}`);
      } catch (error) {
        console.error('Error sending image to channel:', error);
      }
    }
    
    // Send file second (if available)
    if (fileReward) {
      try {
        const fileMessage = await bot.sendDocument(CHANNEL_ID, fileReward.filePath, {
          caption: `📁 ${fileReward.fileName}\n🎯 Level ${rewardLevel} Collection\n\n💎 Want exclusive collections like this?\n👥 Invite ${INVITES_PER_REWARD} friends to unlock rewards!\n\n🚀 Join the reward program: https://t.me/${BOT_USERNAME}`
        });
        fileMessageId = fileMessage.message_id;
        console.log(`File sent to channel for level ${rewardLevel}`);
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
      referralCount: triggerReferrals
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

// NEW: Function to check and send fallback content (every 48 hours)
async function checkAndSendFallback() {
  try {
    const stats = await Stats.findOne();
    const now = new Date();
    const lastPost = stats?.lastChannelPost;
    
    // Check if 48 hours have passed since last post
    if (!lastPost || (now - lastPost) >= (48 * 60 * 60 * 1000)) {
      console.log('48 hours passed without channel post, sending fallback content...');
      
      // Get a random reward to send as fallback
      const rewards = await Reward.find();
      if (rewards.length > 0) {
        const randomReward = rewards[Math.floor(Math.random() * rewards.length)];
        await sendToChannel(randomReward.level, 0);
        
        // Notify admins
        for (const adminId of ADMIN_IDS) {
          try {
            await bot.sendMessage(adminId, 
              `⏰ Fallback content sent to channel!\n\n` +
              `📅 Last post was ${lastPost ? Math.floor((now - lastPost) / (1000 * 60 * 60)) : '48+'} hours ago\n` +
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

// UPDATED: Function to count referral and trigger channel post
async function countReferral(user) {
  if (!user.referredBy || user.referralCounted) return;
  
  const referrer = await User.findOne({ userId: user.referredBy });
  if (!referrer) return;
  
  // Count the referral
  referrer.inviteCount += 1;
  referrer.totalEarned += 1;
  await referrer.save();
  
  // Mark referral as counted
  user.referralCounted = true;
  await user.save();
  
  console.log(`Referral counted: User ${user.userId} -> Referrer ${referrer.userId} (${referrer.inviteCount} total)`);
  
  // Check if referrer gets reward AND if we should send to channel
  const rewardLevel = Math.floor(referrer.inviteCount / INVITES_PER_REWARD) * INVITES_PER_REWARD;
  if (rewardLevel > referrer.lastRewardLevel && rewardLevel > 0) {
    await sendReward(referrer.userId, rewardLevel);
    referrer.lastRewardLevel = rewardLevel;
    await referrer.save();
    
    // NEW: Send to channel every 2 successful referrals
    if (referrer.inviteCount % INVITES_PER_REWARD === 0) {
      console.log(`Triggering channel post for level ${rewardLevel} (${referrer.inviteCount} referrals)`);
      await sendToChannel(rewardLevel, INVITES_PER_REWARD);
      
      // Notify admins about channel post
      for (const adminId of ADMIN_IDS) {
        try {
          await bot.sendMessage(adminId, 
            `🎉 Channel post triggered!\n\n` +
            `👤 User: ${referrer.firstName} (${referrer.userId})\n` +
            `📊 Referrals: ${referrer.inviteCount}\n` +
            `🎯 Level: ${rewardLevel}\n` +
            `📢 Content sent to @${CHANNEL_USERNAME}`
          );
        } catch (error) {
          console.error(`Error notifying admin ${adminId}:`, error);
        }
      }
    }
  }
  
  // Notify referrer
  bot.sendMessage(referrer.userId, 
    `🎉 Referral confirmed! ${user.firstName} joined the channel!\n` +
    `📊 Your invites: ${referrer.inviteCount}\n` +
    `🎯 Next reward at: ${Math.ceil(referrer.inviteCount / INVITES_PER_REWARD) * INVITES_PER_REWARD} invites`
  ).catch(() => {});
  
  return referrer;
}

// NEW: Bulk upload rewards command
bot.onText(/\/bulk_upload/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) {
    return bot.sendMessage(chatId, '❌ You are not authorized to use admin commands.');
  }
  
  const helpMessage = 
    `📦 Bulk Upload Instructions:\n\n` +
    `1️⃣ Send multiple files/images with /bulk_upload_files\n` +
    `2️⃣ Files will be automatically sorted by name (1, 2, 3...)\n` +
    `3️⃣ Images become preview files (isImageFile: true)\n` +
    `4️⃣ ZIP/RAR files become download rewards (isImageFile: false)\n\n` +
    `📝 Naming Convention:\n` +
    `• Image: "1.jpg" = Level 2 preview (level = number * 2)\n` +
    `• File: "1.zip" = Level 2 download\n` +
    `• Image: "2.png" = Level 4 preview\n` +
    `• File: "2.rar" = Level 4 download\n\n` +
    `⚠️ Reply to this message with files to start bulk upload`;
  
  await bot.sendMessage(chatId, helpMessage);
});

// NEW: Handle bulk upload files
bot.onText(/\/bulk_upload_files/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) return;
  
  bot.sendMessage(chatId, 
    `📤 Bulk Upload Mode Activated!\n\n` +
    `📁 Send multiple files now (images and zip files)\n` +
    `⏰ You have 5 minutes to send all files\n` +
    `✅ Send /bulk_finish when done`
  );
  
  // Store bulk upload session
  global.bulkUploadSessions = global.bulkUploadSessions || {};
  global.bulkUploadSessions[userId] = {
    files: [],
    startTime: Date.now(),
    chatId: chatId
  };
  
  // Auto-finish after 5 minutes
  setTimeout(() => {
    if (global.bulkUploadSessions[userId]) {
      finishBulkUpload(userId);
    }
  }, 5 * 60 * 1000);
});

// NEW: Finish bulk upload
bot.onText(/\/bulk_finish/, async (msg) => {
  const userId = msg.from.id;
  if (!isAdmin(userId)) return;
  
  await finishBulkUpload(userId);
});

// NEW: Process bulk upload
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
  
  // Sort files by extracted number from filename
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
      const level = fileNumber * INVITES_PER_REWARD; // Convert to reward level
      const isImageFile = isImageFileType(file.fileName);
      
      // Check if reward already exists
      const existingReward = await Reward.findOne({ level, isImageFile });
      if (existingReward) {
        console.log(`Skipping ${file.fileName} - reward level ${level} (${isImageFile ? 'image' : 'file'}) already exists`);
        continue;
      }
      
      const reward = new Reward({
        rewardId: Date.now() + Math.random() * 1000,
        level: level,
        fileName: file.fileName,
        filePath: file.fileId,
        imageName: isImageFile ? file.fileName : null,
        imagePath: isImageFile ? file.fileId : null,
        description: `Level ${level} ${isImageFile ? 'preview' : 'reward'}`,
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
    `✅ Bulk Upload Complete!\n\n` +
    `📁 Files processed: ${processed}\n` +
    `❌ Errors: ${errors}\n` +
    `📊 Total files received: ${files.length}\n\n` +
    `🎯 Rewards created for levels: ${files.map(f => extractNumberFromFilename(f.fileName) * INVITES_PER_REWARD).join(', ')}`;
  
  await bot.sendMessage(chatId, resultMessage);
  await updateStats();
}

// Helper function to extract number from filename
function extractNumberFromFilename(filename) {
  const match = filename.match(/(\d+)/);
  return match ? parseInt(match[1]) : 999; // Default to high number if no number found
}

// Helper function to check if file is image type
function isImageFileType(filename) {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  const ext = path.extname(filename.toLowerCase());
  return imageExtensions.includes(ext);
}

// Handle file uploads during bulk upload session
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
    `📁 File received: ${file.fileName}\n` +
    `📊 Total files: ${session.files.length}\n` +
    `⏰ Send more files or /bulk_finish when done`
  );
});

// Handle photo uploads during bulk upload session
bot.on('photo', async (msg) => {
  const userId = msg.from.id;
  const session = global.bulkUploadSessions?.[userId];
  
  if (!session || !isAdmin(userId)) return;
  
  const photo = msg.photo[msg.photo.length - 1]; // Get highest resolution
  const fileName = msg.caption || `photo_${Date.now()}.jpg`;
  
  const file = {
    fileName: fileName,
    fileId: photo.file_id,
    fileSize: photo.file_size
  };
  
  session.files.push(file);
  
  bot.sendMessage(msg.chat.id, 
    `🖼️ Image received: ${fileName}\n` +
    `📊 Total files: ${session.files.length}\n` +
    `⏰ Send more files or /bulk_finish when done`
  );
});

// UPDATED: Enhanced reward management commands
bot.onText(/\/reward (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const level = parseInt(match[1]);
  
  if (!isAdmin(userId)) return;
  
  if (!msg.reply_to_message || (!msg.reply_to_message.document && !msg.reply_to_message.photo)) {
    return bot.sendMessage(chatId, '❌ Please reply to a file or image with /reward <level>');
  }
  
  try {
    let fileName, fileId, isImageFile;
    
    if (msg.reply_to_message.document) {
      const document = msg.reply_to_message.document;
      fileName = document.file_name;
      fileId = document.file_id;
      isImageFile = isImageFileType(fileName);
    } else if (msg.reply_to_message.photo) {
      const photo = msg.reply_to_message.photo[msg.reply_to_message.photo.length - 1];
      fileName = msg.reply_to_message.caption || `image_${level}.jpg`;
      fileId = photo.file_id;
      isImageFile = true;
    }
    
    // Save reward to database
    const reward = new Reward({
      rewardId: Date.now(),
      level,
      fileName,
      filePath: fileId,
      imageName: isImageFile ? fileName : null,
      imagePath: isImageFile ? fileId : null,
      description: `Level ${level} ${isImageFile ? 'preview' : 'reward'}`,
      addedBy: userId,
      isImageFile: isImageFile
    });
    
    await reward.save();
    
    bot.sendMessage(chatId, 
      `✅ Reward added successfully!\n` +
      `📁 File: ${fileName}\n` +
      `🎯 Level: ${level}\n` +
      `🎨 Type: ${isImageFile ? 'Image Preview' : 'Download File'}\n` +
      `🆔 Reward ID: ${reward.rewardId}`
    );
    
  } catch (error) {
    console.error('Add reward error:', error);
    bot.sendMessage(chatId, '❌ Error adding reward.');
  }
});

// UPDATED: List rewards with image/file distinction
bot.onText(/\/rewards/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) return;
  
  try {
    const rewards = await Reward.find().sort({ level: 1, isImageFile: -1 });
    
    if (rewards.length === 0) {
      return bot.sendMessage(chatId, '❌ No rewards found.');
    }
    
    let message = `🎁 Rewards List:\n\n`;
    
    rewards.forEach(reward => {
      const typeIcon = reward.isImageFile ? '🖼️' : '📁';
      const typeText = reward.isImageFile ? 'Image' : 'File';
      
      message += 
        `${typeIcon} Level ${reward.level} (${typeText})\n` +
        `📁 File: ${reward.fileName}\n` +
        `🆔 ID: ${reward.rewardId}\n` +
        `📅 Added: ${reward.addedAt.toDateString()}\n\n`;
    });
    
    await bot.sendMessage(chatId, message);
    
  } catch (error) {
    console.error('Rewards list error:', error);
    bot.sendMessage(chatId, '❌ Error fetching rewards.');
  }
});

// NEW: Manual channel post command
bot.onText(/\/send_channel (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const level = parseInt(match[1]);
  
  if (!isAdmin(userId)) return;
  
  try {
    const result = await sendToChannel(level, 0);
    
    if (result) {
      bot.sendMessage(chatId, 
        `✅ Content sent to @${CHANNEL_USERNAME}!\n\n` +
        `🎯 Level: ${level}\n` +
        `🖼️ Image Message ID: ${result.imageMessageId || 'None'}\n` +
        `📁 File Message ID: ${result.fileMessageId || 'None'}`
      );
    } else {
      bot.sendMessage(chatId, `❌ No rewards found for level ${level}`);
    }
    
  } catch (error) {
    console.error('Manual channel send error:', error);
    bot.sendMessage(chatId, '❌ Error sending to channel.');
  }
});

// NEW: Channel post history
bot.onText(/\/channel_history/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) return;
  
  try {
    const posts = await ChannelPost.find().sort({ sentAt: -1 }).limit(10);
    
    if (posts.length === 0) {
      return bot.sendMessage(chatId, '📭 No channel posts found.');
    }
    
    let message = `📢 Recent Channel Posts:\n\n`;
    
    posts.forEach((post, index) => {
      message += 
        `${index + 1}. Level ${post.rewardLevel}\n` +
        `📅 ${post.sentAt.toLocaleString()}\n` +
        `👥 Referrals: ${post.referralCount}\n` +
        `🖼️ Image: ${post.imageMessageId ? '✅' : '❌'}\n` +
        `📁 File: ${post.fileMessageId ? '✅' : '❌'}\n\n`;
    });
    
    await bot.sendMessage(chatId, message);
    
  } catch (error) {
    console.error('Channel history error:', error);
    bot.sendMessage(chatId, '❌ Error fetching channel history.');
  }
});

// Rest of the original bot code remains the same...
// IMPROVED: Periodic channel membership check
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
          
          const wasChannelMember = user.joinedChannel;
          user.joinedChannel = true;
          
          if (user.referredBy && !user.referralCounted) {
            const referrer = await countReferral(user);
            
            if (referrer) {
              bot.sendMessage(user.userId, 
                `🎉 Welcome to @${CHANNEL_USERNAME}!\n\n` +
                `✅ Your referral has been counted for your inviter!\n` +
                `🎁 You can now earn rewards by inviting others too!\n\n` +
                `🔗 Get your invite link: /link\n` +
                `📊 Check your stats: /stats`
              ).catch(() => {});
              
              console.log(`Referral counted for user ${user.userId} -> referrer ${referrer.userId}`);
            } else {
              bot.sendMessage(user.userId, 
                `🎉 Welcome to @${CHANNEL_USERNAME}!\n\n` +
                `🎁 Start earning rewards by inviting others!\n\n` +
                `🔗 Get your invite link: /link\n` +
                `📊 Check your stats: /stats`
              ).catch(() => {});
            }
          } else {
            bot.sendMessage(user.userId, 
              `🎉 Welcome to @${CHANNEL_USERNAME}!\n\n` +
              `🎁 Start earning rewards by inviting others!\n\n` +
              `🔗 Get your invite link: /link\n` +
              `📊 Check your stats: /stats`
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
      console.log(`Detected ${detectedJoins} new channel joins through periodic check`);
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
        console.log(`User ${userId} joined channel - detected through interaction`);
        
        if (user.referredBy && !user.referralCounted) {
          const referrer = await countReferral(user);
          
          if (referrer) {
            bot.sendMessage(userId, 
              `🎉 Great! We detected you joined @${CHANNEL_USERNAME}!\n\n` +
              `✅ Your referral has been counted!\n` +
              `🎁 You can now earn rewards by inviting others!\n\n` +
              `🔗 Get your invite link: /link`
            ).catch(() => {});
          }
        }
      }
      
      await user.save();
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('Error checking membership during interaction:', error);
    return false;
  }
}

// Send reward function
async function sendReward(userId, level) {
  try {
    const rewards = await Reward.find({ level });
    if (rewards.length === 0) return;
    
    for (const reward of rewards) {
      await sendRewardFile(userId, reward, `🎉 Congratulations! You've earned a Level ${level} reward!`);
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

// Bot commands
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
            `📝 They need to join @${CHANNEL_USERNAME} to count as a referral.\n` +
            `📊 Current confirmed invites: ${referrer.inviteCount}`
          ).catch(() => {});
        }
      }
      
      await user.save();
      await updateStats();
      
      if (!user.bonusReceived) {
        const bonusReward = await Reward.findOne({ level: 0 });
        if (bonusReward) {
          await sendRewardFile(userId, bonusReward, "🎁 Welcome Bonus!");
          user.bonusReceived = true;
          await user.save();
        }
      }
    }
    
    let welcomeMessage;
    
    if (isNewUser && hasReferrer) {
      welcomeMessage = 
        `🎉 Welcome to StitchVault Rewards Bot!\n\n` +
        `🔥 You were invited by someone awesome!\n` +
        `🎁 You received a welcome bonus!\n\n` +
        `⚠️ **IMPORTANT: Join @${CHANNEL_USERNAME} first to activate your referral and unlock all features!**\n\n` +
        `💰 After joining, you can earn rewards every ${INVITES_PER_REWARD} invites!\n` +
        `📊 Check your stats: /stats\n` +
        `❓ Need help: /help`;
    } else if (isNewUser) {
      welcomeMessage = 
        `🎉 Welcome to StitchVault Rewards Bot!\n\n` +
        `🎁 You received a welcome bonus!\n` +
        `📱 **Join our channel to unlock referral rewards!**\n\n` +
        `💰 Earn rewards every ${INVITES_PER_REWARD} invites!\n` +
        `🔗 Get your personal invite link: /link\n` +
        `📊 Check your stats: /stats\n` +
        `❓ Need help: /help`;
    } else {
      welcomeMessage = 
        `👋 Welcome back ${msg.from.first_name}!\n\n` +
        `📊 Your current invites: ${user.inviteCount}\n` +
        `🎯 Next reward at: ${Math.ceil(user.inviteCount / INVITES_PER_REWARD) * INVITES_PER_REWARD} invites\n\n` +
        `🔗 Get your invite link: /link\n` +
        `📊 Check detailed stats: /stats`;
    }
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '📱 Join StitchVault Channel', url: `https://t.me/${CHANNEL_USERNAME}` }],
        [{ text: '🔗 Get Invite Link', callback_data: 'get_link' }],
        [{ text: '📊 My Stats', callback_data: 'my_stats' }]
      ]
    };
    
    await bot.sendMessage(chatId, welcomeMessage, { reply_markup: keyboard });
    
  } catch (error) {
    console.error('Start command error:', error);
    bot.sendMessage(chatId, '⚠️ An error occurred. Please try again.');
  }
});

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
    
    const inviteLink = `https://t.me/${BOT_USERNAME}?start=${user.referralCode}`;
    
    const message = 
      `🔗 Your Personal Invite Link:\n` +
      `${inviteLink}\n\n` +
      `📊 Current Stats:\n` +
      `👥 Invites: ${user.inviteCount}\n` +
      `🎯 Next reward: ${Math.ceil(user.inviteCount / INVITES_PER_REWARD) * INVITES_PER_REWARD} invites\n\n` +
      `💡 Share this link with friends to earn rewards!\n` +
      `📱 **Remember: Invites only count after users join @${CHANNEL_USERNAME}**`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '📤 Share Link', url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent('Join StitchVault for amazing digital content! 📱✨')}` }],
        [{ text: '📱 Join Channel', url: `https://t.me/${CHANNEL_USERNAME}` }]
      ]
    };
    
    await bot.sendMessage(chatId, message, { reply_markup: keyboard });
    
  } catch (error) {
    console.error('Link command error:', error);
    bot.sendMessage(chatId, '⚠️ An error occurred. Please try again.');
  }
});

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
    
    const nextRewardLevel = Math.ceil(updatedUser.inviteCount / INVITES_PER_REWARD) * INVITES_PER_REWARD;
    const progress = updatedUser.inviteCount % INVITES_PER_REWARD;
    const needed = INVITES_PER_REWARD - progress;
    
    let referralStatus = '';
    if (updatedUser.referredBy && !updatedUser.referralCounted) {
      referralStatus = `\n🔥 Pending referral (join channel to activate)`;
    } else if (updatedUser.referredBy && updatedUser.referralCounted) {
      referralStatus = `\n✅ Referral counted`;
    }
    
    const message = 
      `📊 Your Statistics:\n\n` +
      `👤 User: ${updatedUser.firstName} ${updatedUser.lastName || ''}\n` +
      `🆔 ID: ${updatedUser.userId}\n` +
      `📅 Joined: ${updatedUser.joinedAt.toDateString()}\n\n` +
      `📈 Invite Stats:\n` +
      `👥 Total Invites: ${updatedUser.inviteCount}\n` +
      `💰 Total Earned: ${updatedUser.totalEarned}\n` +
      `🏆 Last Reward Level: ${updatedUser.lastRewardLevel}\n` +
      `🎯 Next Reward: ${nextRewardLevel} invites\n` +
      `📝 Progress: ${progress}/${INVITES_PER_REWARD} (${needed} more needed)\n\n` +
      `🔗 Your Referral Code: ${updatedUser.referralCode}\n` +
      `📱 Channel Member: ${updatedUser.joinedChannel ? '✅' : '❌'}${referralStatus}`;
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '🔗 Get Invite Link', callback_data: 'get_link' }],
        [{ text: '📱 Join Channel', url: `https://t.me/${CHANNEL_USERNAME}` }]
      ]
    };
    
    await bot.sendMessage(chatId, message, { reply_markup: keyboard });
    
  } catch (error) {
    console.error('Stats command error:', error);
    bot.sendMessage(chatId, '⚠️ An error occurred. Please try again.');
  }
});

// Admin commands
bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) {
    return bot.sendMessage(chatId, '❌ You are not authorized to use admin commands.');
  }
  
  const adminHelp = 
    `👨‍💼 Admin Commands:\n\n` +
    `/stats_admin - Bot statistics\n` +
    `/users - List all users\n` +
    `/user <id> - Get user info\n` +
    `/reward <level> - Add reward (reply to file)\n` +
    `/bulk_upload - Bulk upload instructions\n` +
    `/bulk_upload_files - Start bulk upload\n` +
    `/rewards - List all rewards\n` +
    `/send_channel <level> - Send to channel manually\n` +
    `/channel_history - View channel post history\n` +
    `/broadcast <message> - Send to all users\n` +
    `/block <id> - Block user\n` +
    `/unblock <id> - Unblock user\n` +
    `/backup - Download user database`;
  
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
    
    const message = 
      `📊 Bot Statistics:\n\n` +
      `👥 Total Users: ${totalUsers}\n` +
      `🟢 Active Users (7d): ${activeUsers}\n` +
      `📱 Channel Members: ${channelMembers}\n` +
      `🔗 Total Invites: ${totalInvites[0]?.total || 0}\n` +
      `⏳ Pending Referrals: ${pendingReferrals}\n` +
      `🎁 Total Rewards: ${totalRewards}\n` +
      `📢 Channel Posts: ${channelPosts}\n` +
      `📅 Last Channel Post: ${stats.lastChannelPost ? stats.lastChannelPost.toLocaleString() : 'Never'}\n` +
      `📅 Last Updated: ${new Date().toLocaleString()}`;
    
    await bot.sendMessage(chatId, message);
    
  } catch (error) {
    console.error('Admin stats error:', error);
    bot.sendMessage(chatId, '❌ Error fetching statistics.');
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
        text: 'You are temporarily restricted from using this bot.',
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
      
      const inviteLink = `https://t.me/${BOT_USERNAME}?start=${user.referralCode}`;
      
      const message = 
        `🔗 Your Personal Invite Link:\n` +
        `${inviteLink}\n\n` +
        `📊 Current Stats:\n` +
        `👥 Invites: ${user.inviteCount}\n` +
        `🎯 Next reward: ${Math.ceil(user.inviteCount / INVITES_PER_REWARD) * INVITES_PER_REWARD} invites\n\n` +
        `💡 Share this link with friends to earn rewards!\n` +
        `📱 **Remember: Invites only count after users join @${CHANNEL_USERNAME}**`;
      
      const keyboard = {
        inline_keyboard: [
          [{ text: '📤 Share Link', url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent('Join StitchVault for amazing digital content! 📱✨')}` }],
          [{ text: '📱 Join Channel', url: `https://t.me/${CHANNEL_USERNAME}` }]
        ]
      };
      
      await bot.sendMessage(chatId, message, { reply_markup: keyboard });
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Here\'s your invite link!' });
      
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
          const referrer = await countReferral(user);
          
          if (referrer) {
            bot.sendMessage(userId, 
              `🎉 Welcome to @${CHANNEL_USERNAME}!\n\n` +
              `✅ Your referral has been counted for your inviter!\n` +
              `🎁 You can now earn rewards by inviting others too!\n\n` +
              `🔗 Get your invite link: /link`
            ).catch(() => {});
          } else {
            bot.sendMessage(userId, 
              `🎉 Welcome to @${CHANNEL_USERNAME}!\n\n` +
              `🎁 Start earning rewards by inviting others!\n\n` +
              `🔗 Get your invite link: /link`
            ).catch(() => {});
          }
        } else if (!wasChannelMember) {
          bot.sendMessage(userId, 
            `🎉 Welcome to @${CHANNEL_USERNAME}!\n\n` +
            `🎁 Start earning rewards by inviting others!\n\n` +
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

// UPDATED: Cron jobs
// Check for fallback content every 24 hours
cron.schedule('0 0 * * *', async () => {
  console.log('Running daily fallback check...');
  await checkAndSendFallback();
  await updateStats();
});

// Periodic membership check every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  await periodicMembershipCheck();
});

console.log('Enhanced StitchVault Bot with Channel Auto-Send started successfully!');
