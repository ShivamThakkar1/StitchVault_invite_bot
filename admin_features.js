// Enhanced admin features for StitchVault Bot with bulk upload functionality

// List all users with pagination
bot.onText(/\/users(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const page = parseInt(match[1]) || 1;
  
  if (!isAdmin(userId)) return;
  
  try {
    const limit = 10;
    const skip = (page - 1) * limit;
    
    const users = await User.find()
      .sort({ joinedAt: -1 })
      .skip(skip)
      .limit(limit);
    
    const totalUsers = await User.countDocuments();
    const totalPages = Math.ceil(totalUsers / limit);
    
    let message = `👥 Users List (Page ${page}/${totalPages}):\n\n`;
    
    users.forEach((user, index) => {
      const referralStatus = user.referredBy ? 
        (user.referralCounted ? '✅' : '⏳') : '';
      
      message += 
        `${skip + index + 1}. ${user.firstName} ${user.lastName || ''}\n` +
        `🆔 ${user.userId} | 👥 ${user.inviteCount} invites ${referralStatus}\n` +
        `📱 ${user.joinedChannel ? '✅' : '❌'} | 🚫 ${user.isBlocked ? 'Blocked' : 'Active'}\n\n`;
    });
    
    const keyboard = {
      inline_keyboard: []
    };
    
    const navButtons = [];
    if (page > 1) {
      navButtons.push({ text: '⬅️ Previous', callback_data: `users_page_${page - 1}` });
    }
    if (page < totalPages) {
      navButtons.push({ text: 'Next ➡️', callback_data: `users_page_${page + 1}` });
    }
    
    if (navButtons.length > 0) {
      keyboard.inline_keyboard.push(navButtons);
    }
    
    await bot.sendMessage(chatId, message, { 
      reply_markup: keyboard.inline_keyboard.length > 0 ? keyboard : undefined 
    });
    
  } catch (error) {
    console.error('Users list error:', error);
    bot.sendMessage(chatId, '❌ Error fetching users list.');
  }
});

// Get specific user info
bot.onText(/\/user (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const targetUserId = parseInt(match[1]);
  
  if (!isAdmin(userId)) return;
  
  try {
    const user = await User.findOne({ userId: targetUserId });
    
    if (!user) {
      return bot.sendMessage(chatId, '❌ User not found.');
    }
    
    const referredUsers = await User.countDocuments({ 
      referredBy: targetUserId,
      referralCounted: true 
    });
    const pendingReferrals = await User.countDocuments({ 
      referredBy: targetUserId,
      referralCounted: false 
    });
    const referrer = user.referredBy ? await User.findOne({ userId: user.referredBy }) : null;
    
    const message = 
      `👤 User Information:\n\n` +
      `🆔 User ID: ${user.userId}\n` +
      `👤 Name: ${user.firstName} ${user.lastName || ''}\n` +
      `🔗 Username: ${user.username ? '@' + user.username : 'Not set'}\n` +
      `📅 Joined: ${user.joinedAt.toDateString()}\n` +
      `📅 Last Active: ${user.lastActivity.toDateString()}\n\n` +
      `📊 Statistics:\n` +
      `👥 Invites: ${user.inviteCount}\n` +
      `💰 Total Earned: ${user.totalEarned}\n` +
      `🏆 Last Reward: Level ${user.lastRewardLevel}\n` +
      `🎁 Bonus Received: ${user.bonusReceived ? '✅' : '❌'}\n\n` +
      `📱 Channel Status: ${user.joinedChannel ? '✅ Member' : '❌ Not Member'}\n` +
      `🚫 Status: ${user.isBlocked ? '🚫 Blocked' : '✅ Active'}\n\n` +
      `🔗 Referral Info:\n` +
      `📝 Code: ${user.referralCode}\n` +
      `👤 Referred by: ${referrer ? `${referrer.firstName} (${referrer.userId})` : 'Direct join'}\n` +
      `✅ Referral counted: ${user.referralCounted ? 'Yes' : 'No'}\n` +
      `👥 Confirmed referrals: ${referredUsers}\n` +
      `⏳ Pending referrals: ${pendingReferrals}`;
    
    const keyboard = {
      inline_keyboard: [
        [
          { text: user.isBlocked ? '✅ Unblock' : '🚫 Block', callback_data: `admin_${user.isBlocked ? 'unblock' : 'block'}_${user.userId}` },
          { text: '🔄 Reset Stats', callback_data: `admin_reset_${user.userId}` }
        ]
      ]
    };
    
    await bot.sendMessage(chatId, message, { reply_markup: keyboard });
    
  } catch (error) {
    console.error('User info error:', error);
    bot.sendMessage(chatId, '❌ Error fetching user information.');
  }
});

// Block/Unblock users
bot.onText(/\/block (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const targetUserId = parseInt(match[1]);
  
  if (!isAdmin(userId)) return;
  
  try {
    const user = await User.findOneAndUpdate(
      { userId: targetUserId },
      { isBlocked: true },
      { new: true }
    );
    
    if (!user) {
      return bot.sendMessage(chatId, '❌ User not found.');
    }
    
    bot.sendMessage(chatId, `🚫 User ${user.firstName} (${targetUserId}) has been blocked.`);
    
    bot.sendMessage(targetUserId, 
      '🚫 You have been temporarily restricted from using this bot. Contact support if you believe this is an error.'
    ).catch(() => {});
    
  } catch (error) {
    console.error('Block user error:', error);
    bot.sendMessage(chatId, '❌ Error blocking user.');
  }
});

bot.onText(/\/unblock (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const targetUserId = parseInt(match[1]);
  
  if (!isAdmin(userId)) return;
  
  try {
    const user = await User.findOneAndUpdate(
      { userId: targetUserId },
      { isBlocked: false },
      { new: true }
    );
    
    if (!user) {
      return bot.sendMessage(chatId, '❌ User not found.');
    }
    
    bot.sendMessage(chatId, `✅ User ${user.firstName} (${targetUserId}) has been unblocked.`);
    
    bot.sendMessage(targetUserId, 
      '✅ You have been unblocked and can now use the bot normally!'
    ).catch(() => {});
    
  } catch (error) {
    console.error('Unblock user error:', error);
    bot.sendMessage(chatId, '❌ Error unblocking user.');
  }
});

// Broadcast message
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const message = match[1];
  
  if (!isAdmin(userId)) return;
  
  try {
    const users = await User.find({ isBlocked: false });
    let sent = 0;
    let failed = 0;
    
    bot.sendMessage(chatId, `📤 Starting broadcast to ${users.length} users...`);
    
    for (const user of users) {
      try {
        await bot.sendMessage(user.userId, `📢 ${message}`);
        sent++;
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        failed++;
      }
    }
    
    bot.sendMessage(chatId, 
      `📊 Broadcast completed!\n` +
      `✅ Sent: ${sent}\n` +
      `❌ Failed: ${failed}`
    );
    
  } catch (error) {
    console.error('Broadcast error:', error);
    bot.sendMessage(chatId, '❌ Error sending broadcast.');
  }
});

// Delete reward
bot.onText(/\/delete_reward (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const rewardId = parseInt(match[1]);
  
  if (!isAdmin(userId)) return;
  
  try {
    const reward = await Reward.findOneAndDelete({ rewardId });
    
    if (!reward) {
      return bot.sendMessage(chatId, '❌ Reward not found.');
    }
    
    bot.sendMessage(chatId, 
      `✅ Reward deleted successfully!\n` +
      `📝 File: ${reward.fileName}\n` +
      `🎯 Level: ${reward.level}\n` +
      `🎨 Type: ${reward.isImageFile ? 'Image' : 'File'}`
    );
    
  } catch (error) {
    console.error('Delete reward error:', error);
    bot.sendMessage(chatId, '❌ Error deleting reward.');
  }
});

// Reset user stats
bot.onText(/\/reset_user (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const targetUserId = parseInt(match[1]);
  
  if (!isAdmin(userId)) return;
  
  try {
    const user = await User.findOneAndUpdate(
      { userId: targetUserId },
      {
        inviteCount: 0,
        totalEarned: 0,
        lastRewardLevel: 0,
        bonusReceived: false,
        referralCounted: false
      },
      { new: true }
    );
    
    if (!user) {
      return bot.sendMessage(chatId, '❌ User not found.');
    }
    
    bot.sendMessage(chatId, `🔄 Stats reset for ${user.firstName} (${targetUserId})`);
    
    bot.sendMessage(targetUserId, 
      '🔄 Your bot statistics have been reset by an admin. You can start fresh!'
    ).catch(() => {});
    
  } catch (error) {
    console.error('Reset user error:', error);
    bot.sendMessage(chatId, '❌ Error resetting user stats.');
  }
});

// Export user data
bot.onText(/\/backup/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) return;
  
  try {
    const users = await User.find({}, '-_id -__v').lean();
    const rewards = await Reward.find({}, '-_id -__v').lean();
    const stats = await Stats.findOne({}, '-_id -__v').lean();
    const channelPosts = await ChannelPost.find({}, '-_id -__v').lean();
    
    const backup = {
      exportDate: new Date().toISOString(),
      botName: 'StitchVault',
      users,
      rewards,
      stats,
      channelPosts
    };
    
    const backupData = JSON.stringify(backup, null, 2);
    const fileName = `stitchvault_backup_${new Date().toISOString().split('T')[0]}.json`;
    
    await bot.sendDocument(chatId, Buffer.from(backupData), {
      filename: fileName,
      caption: `📁 Bot backup generated on ${new Date().toLocaleString()}`
    });
    
  } catch (error) {
    console.error('Backup error:', error);
    bot.sendMessage(chatId, '❌ Error creating backup.');
  }
});

// Top users leaderboard
bot.onText(/\/top(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const limit = parseInt(match[1]) || 10;
  
  if (!isAdmin(userId)) return;
  
  try {
    const topUsers = await User.find({ inviteCount: { $gt: 0 } })
      .sort({ inviteCount: -1 })
      .limit(limit);
    
    let message = `🏆 Top ${Math.min(limit, topUsers.length)} Users:\n\n`;
    
    topUsers.forEach((user, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
      message += 
        `${medal} ${user.firstName} ${user.lastName || ''}\n` +
        `👥 ${user.inviteCount} invites | 💰 ${user.totalEarned} earned\n` +
        `🆔 ${user.userId}\n\n`;
    });
    
    if (topUsers.length === 0) {
      message = '❌ No users with invites found.';
    }
    
    await bot.sendMessage(chatId, message);
    
  } catch (error) {
    console.error('Top users error:', error);
    bot.sendMessage(chatId, '❌ Error fetching top users.');
  }
});

// Send custom reward to specific user
bot.onText(/\/send_reward (\d+) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const targetUserId = parseInt(match[1]);
  const rewardLevel = parseInt(match[2]);
  
  if (!isAdmin(userId)) return;
  
  try {
    const user = await User.findOne({ userId: targetUserId });
    const rewards = await Reward.find({ level: rewardLevel });
    
    if (!user) {
      return bot.sendMessage(chatId, '❌ User not found.');
    }
    
    if (rewards.length === 0) {
      return bot.sendMessage(chatId, '❌ No rewards found for this level.');
    }
    
    for (const reward of rewards) {
      await sendRewardFile(targetUserId, reward, `🎁 Special reward from admin!`);
    }
    
    bot.sendMessage(chatId, 
      `✅ Rewards sent to ${user.firstName}!\n` +
      `🎯 Level: ${rewardLevel}\n` +
      `📦 Items sent: ${rewards.length}`
    );
    
  } catch (error) {
    console.error('Send custom reward error:', error);
    bot.sendMessage(chatId, '❌ Error sending reward.');
  }
});

// Clear all rewards for a specific level
bot.onText(/\/clear_level (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const level = parseInt(match[1]);
  
  if (!isAdmin(userId)) return;
  
  try {
    const result = await Reward.deleteMany({ level });
    
    bot.sendMessage(chatId, 
      `🗑️ Cleared level ${level}!\n` +
      `📦 Deleted ${result.deletedCount} rewards`
    );
    
  } catch (error) {
    console.error('Clear level error:', error);
    bot.sendMessage(chatId, '❌ Error clearing level.');
  }
});

// Force channel post for testing
bot.onText(/\/test_channel (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const level = parseInt(match[1]);
  
  if (!isAdmin(userId)) return;
  
  try {
    await sendToChannel(level, 999); // 999 indicates test post
    bot.sendMessage(chatId, `✅ Test channel post sent for level ${level}`);
  } catch (error) {
    console.error('Test channel error:', error);
    bot.sendMessage(chatId, '❌ Error sending test post.');
  }
});

// Handle callback queries for admin actions
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;
  
  if (!isAdmin(userId)) {
    return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Not authorized' });
  }
  
  try {
    if (data.startsWith('users_page_')) {
      const page = parseInt(data.split('_')[2]);
      bot.emit('message', { 
        chat: { id: chatId }, 
        from: callbackQuery.from, 
        text: `/users ${page}` 
      });
    } else if (data.startsWith('admin_block_')) {
      const targetUserId = parseInt(data.split('_')[2]);
      const user = await User.findOneAndUpdate({ userId: targetUserId }, { isBlocked: true });
      if (user) {
        bot.answerCallbackQuery(callbackQuery.id, { text: '✅ User blocked' });
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: chatId,
          message_id: callbackQuery.message.message_id
        });
      } else {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'User not found!', show_alert: true });
      }
    } else if (data.startsWith('admin_unblock_')) {
      const targetUserId = parseInt(data.split('_')[2]);
      const user = await User.findOneAndUpdate({ userId: targetUserId }, { isBlocked: false });
      if (user) {
        bot.answerCallbackQuery(callbackQuery.id, { text: '✅ User unblocked' });
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: chatId,
          message_id: callbackQuery.message.message_id
        });
      } else {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'User not found!', show_alert: true });
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
        bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Stats reset' });
      } else {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'User not found!', show_alert: true });
      }
    }
    
  } catch (error) {
    console.error('Admin callback error:', error);
    bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Error occurred' });
  }
});

// Enhanced bulk upload status tracking
bot.onText(/\/bulk_status/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) return;
  
  const session = global.bulkUploadSessions?.[userId];
  
  if (!session) {
    return bot.sendMessage(chatId, '❌ No active bulk upload session.');
  }
  
  const elapsed = Math.floor((Date.now() - session.startTime) / 1000);
  const remaining = Math.max(0, 300 - elapsed); // 5 minutes = 300 seconds
  
  const message = 
    `📊 Bulk Upload Status:\n\n` +
    `📁 Files received: ${session.files.length}\n` +
    `⏰ Time elapsed: ${elapsed}s\n` +
    `⏳ Time remaining: ${remaining}s\n\n` +
    `📋 Recent files:\n` +
    session.files.slice(-5).map(f => `• ${f.fileName}`).join('\n');
  
  await bot.sendMessage(chatId, message);
});

// Cancel bulk upload
bot.onText(/\/bulk_cancel/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) return;
  
  if (global.bulkUploadSessions?.[userId]) {
    delete global.bulkUploadSessions[userId];
    bot.sendMessage(chatId, '❌ Bulk upload session cancelled.');
  } else {
    bot.sendMessage(chatId, '❌ No active bulk upload session to cancel.');
  }
});

console.log('Enhanced admin features loaded successfully!');
