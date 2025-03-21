require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus } = require('@discordjs/voice');
const { stream } = require('play-dl');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const ytdl = require('ytdl-core');
const ytSearch = require('yt-search');
const axios = require('axios');

// Config
const config = {
  token: process.env.TOKEN,
  prefix: '!',
  dataPath: './data',
  roles: ['Tank', 'Regen Healer', 'Shield Healer', 'Melee DPS', 'Ranged DPS', 'Caster DPS', 'Flex'],
  defaultRaidComp: {
    'Tank': 2,
    'Regen Healer': 1,
    'Shield Healer': 1, 
    'Melee DPS': 2,
    'Ranged DPS': 1,
    'Caster DPS': 1,
    'Flex': 0
  },
  maxPartySize: 8,
  reminderTimes: [
    { name: '24 hours', minutes: 24 * 60 },
    { name: '3 hours', minutes: 3 * 60 },
    { name: '1 hour', minutes: 60 }
  ],
  regularRaids: {
    'raid1': { days: ['Monday', 'Tuesday', 'Thursday'], time: '20:00', name: 'Weekly Static Run' }
  },
  fflogs: {
    clientId: process.env.FFLOGS_CLIENT_ID,
    clientSecret: process.env.FFLOGS_CLIENT_SECRET,
    region: 'na',
    updateInterval: 30
  }
};

// Initialize client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ]
});

// Data storage
let raids = {};
let musicQueues = {};
let fflogsToken = null;
let characterLogs = {};

// Ensure data directory exists
if (!fs.existsSync(config.dataPath)) {
  fs.mkdirSync(config.dataPath, { recursive: true });
}

// Load existing raids
function loadRaids() {
  const raidsPath = path.join(config.dataPath, 'raids.json');
  if (fs.existsSync(raidsPath)) {
    try {
      raids = JSON.parse(fs.readFileSync(raidsPath, 'utf8'));
      console.log('Raids loaded successfully');
      
      // Reschedule reminders for existing raids
      Object.keys(raids).forEach(raidId => {
        scheduleReminders(raidId);
      });
    } catch (error) {
      console.error('Error loading raids:', error);
    }
  }
}

// Load character logs
function loadCharacterLogs() {
  const logsPath = path.join(config.dataPath, 'character_logs.json');
  if (fs.existsSync(logsPath)) {
    try {
      characterLogs = JSON.parse(fs.readFileSync(logsPath, 'utf8'));
      console.log('Character logs loaded successfully');
    } catch (error) {
      console.error('Error loading character logs:', error);
    }
  }
}

// Save raids
function saveRaids() {
  const raidsPath = path.join(config.dataPath, 'raids.json');
  fs.writeFileSync(raidsPath, JSON.stringify(raids, null, 2));
  console.log('Raids saved successfully');
}

// Save character logs
function saveCharacterLogs() {
  const logsPath = path.join(config.dataPath, 'character_logs.json');
  fs.writeFileSync(logsPath, JSON.stringify(characterLogs, null, 2));
  console.log('Character logs saved successfully');
}

// FFLogs API Integration

// Get OAuth token for FFLogs API
async function getFFLogsToken() {
  try {
    const response = await axios.post('https://www.fflogs.com/oauth/token', 
      `grant_type=client_credentials&client_id=${config.fflogs.clientId}&client_secret=${config.fflogs.clientSecret}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    fflogsToken = response.data.access_token;
    console.log('FFLogs token obtained successfully');
    
    // Schedule token refresh (tokens last 24 hours, refresh after 23)
    setTimeout(getFFLogsToken, 23 * 60 * 60 * 1000);
    
    return fflogsToken;
  } catch (error) {
    console.error('Error getting FFLogs token:', error.response?.data || error.message);
    return null;
  }
}

// Register a character with FFLogs
async function registerCharacter(discordUserId, characterName, serverName, region = config.fflogs.region) {
  try {
    // Ensure we have a token
    const token = fflogsToken || await getFFLogsToken();
    if (!token) {
      return { success: false, message: 'Failed to authenticate with FFLogs API' };
    }
    
    // GraphQL query to find character
    const query = `
      query {
        characterData {
          character(name: "${characterName}", serverSlug: "${serverName}", serverRegion: "${region}") {
            id
            name
            server {
              name
              region {
                name
              }
            }
            lodestoneID
          }
        }
      }
    `;
    
    const response = await axios.post('https://www.fflogs.com/api/v2/client', 
      { query },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const character = response.data.data.characterData.character;
    
    if (!character) {
      return { 
        success: false, 
        message: `Character "${characterName}" not found on server "${serverName}" (${region.toUpperCase()})` 
      };
    }
    
    // Store character info
    if (!characterLogs[discordUserId]) {
      characterLogs[discordUserId] = [];
    }
    
    // Check if character already registered
    const existingIndex = characterLogs[discordUserId].findIndex(c => 
      c.id === character.id && c.server === character.server.name
    );
    
    if (existingIndex >= 0) {
      characterLogs[discordUserId][existingIndex] = {
        id: character.id,
        name: character.name,
        server: character.server.name,
        region: character.server.region.name,
        lodestoneId: character.lodestoneID
      };
    } else {
      characterLogs[discordUserId].push({
        id: character.id,
        name: character.name,
        server: character.server.name,
        region: character.server.region.name,
        lodestoneId: character.lodestoneID
      });
    }
    
    saveCharacterLogs();
    
    return { 
      success: true, 
      message: `Successfully registered character "${character.name}" on "${character.server.name}"`,
      character: {
        id: character.id,
        name: character.name,
        server: character.server.name,
        region: character.server.region.name
      }
    };
  } catch (error) {
    console.error('Error registering character:', error.response?.data || error.message);
    return { 
      success: false, 
      message: 'Failed to register character with FFLogs' 
    };
  }
}

// Get recent logs for a character
async function getCharacterLogs(characterId, count = 5) {
  try {
    // Ensure we have a token
    const token = fflogsToken || await getFFLogsToken();
    if (!token) {
      return { success: false, message: 'Failed to authenticate with FFLogs API' };
    }
    
    // GraphQL query to get recent reports for character
    const query = `
      query {
        characterData {
          character(id: ${characterId}) {
            name
            server {
              name
              region {
                name
              }
            }
            recentReports(limit: ${count}) {
              data {
                code
                title
                startTime
                endTime
                zone {
                  name
                }
                fights {
                  name
                  kill
                  fightPercentage
                }
              }
            }
          }
        }
      }
    `;
    
    const response = await axios.post('https://www.fflogs.com/api/v2/client', 
      { query },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const character = response.data.data.characterData.character;
    
    if (!character) {
      return { success: false, message: 'Character not found' };
    }
    
    // Format the report data
    const reports = character.recentReports.data.map(report => {
      // Calculate clear status
      const totalFights = report.fights.length;
      const kills = report.fights.filter(f => f.kill).length;
      
      // Get best pull percentage for non-kill fights
      let bestPull = 100;
      report.fights.forEach(fight => {
        if (!fight.kill && fight.fightPercentage < bestPull) {
          bestPull = fight.fightPercentage;
        }
      });
      
      return {
        code: report.code,
        title: report.title,
        zone: report.zone.name,
        date: new Date(report.startTime).toLocaleDateString(),
        duration: formatDuration((report.endTime - report.startTime) / 1000),
        totalFights,
        kills,
        bestPull: bestPull === 100 ? null : (100 - bestPull).toFixed(1) + '%',
        url: `https://www.fflogs.com/reports/${report.code}`
      };
    });
    
    return {
      success: true,
      character: {
        name: character.name,
        server: character.server.name,
        region: character.server.region.name
      },
      reports
    };
  } catch (error) {
    console.error('Error getting character logs:', error.response?.data || error.message);
    return { success: false, message: 'Failed to retrieve logs from FFLogs' };
  }
}

// Get static performance statistics
async function getStaticPerformance(raidId) {
  const raid = raids[raidId];
  if (!raid) {
    return { success: false, message: 'Raid not found' };
  }
  
  // Get all participant IDs
  const participantIds = Object.keys(raid.participants);
  
  // Create statistics structure
  const stats = {
    raid: raid.name,
    date: new Date(raid.datetime).toLocaleDateString(),
    participants: [],
    zoneAnalysis: {}
  };
  
  // Process each participant
  for (const userId of participantIds) {
    // Skip if user has no registered characters
    if (!characterLogs[userId] || characterLogs[userId].length === 0) {
      continue;
    }
    
    const character = characterLogs[userId][0]; // Use primary character
    const logs = await getCharacterLogs(character.id, 10);
    
    if (!logs.success) {
      continue;
    }
    
    // Add participant data
    stats.participants.push({
      discordId: userId,
      character: character.name,
      server: character.server,
      role: raid.participants[userId].role,
      recentLogs: logs.reports.length
    });
    
    // Analyze zones
    logs.reports.forEach(report => {
      if (!stats.zoneAnalysis[report.zone]) {
        stats.zoneAnalysis[report.zone] = {
          totalPulls: 0,
          totalKills: 0,
          participation: 0,
          bestPull: 0
        };
      }
      
      stats.zoneAnalysis[report.zone].totalPulls += report.totalFights;
      stats.zoneAnalysis[report.zone].totalKills += report.kills;
      stats.zoneAnalysis[report.zone].participation += 1;
      
      // Update best pull if available
      if (report.bestPull) {
        const pullPercent = parseFloat(report.bestPull);
        if (!isNaN(pullPercent) && pullPercent > stats.zoneAnalysis[report.zone].bestPull) {
          stats.zoneAnalysis[report.zone].bestPull = pullPercent;
        }
      }
    });
  }
  
  // Calculate kill ratios for each zone
  Object.keys(stats.zoneAnalysis).forEach(zone => {
    const zoneData = stats.zoneAnalysis[zone];
    zoneData.killRatio = zoneData.totalPulls > 0 ? 
      ((zoneData.totalKills / zoneData.totalPulls) * 100).toFixed(1) + '%' : 
      'N/A';
  });
  
  return { success: true, stats };
}

// Auto-fetch logs after raid
async function autoFetchLogsAfterRaid(raidId) {
  try {
    const raid = raids[raidId];
    if (!raid) return;
    
    console.log(`Auto-fetching logs for raid ${raid.name} (ID: ${raidId})`);
    
    // Get static performance
    const performance = await getStaticPerformance(raidId);
    
    if (!performance.success) {
      console.error(`Failed to get static performance for raid ${raidId}`);
      return;
    }
    
    // Find the original channel
    if (raid.channelId) {
      try {
        const channel = await client.channels.fetch(raid.channelId);
        
        // Create embed with performance data
        const embed = new EmbedBuilder()
          .setTitle(`Raid Performance: ${raid.name}`)
          .setDescription(`Here's the static performance report based on recent logs.`)
          .setColor('#FF5252')
          .setTimestamp();
        
        // Add fields for each zone
        Object.entries(performance.stats.zoneAnalysis).forEach(([zone, data]) => {
          embed.addFields({
            name: zone,
            value: `Pulls: ${data.totalPulls} | Kills: ${data.totalKills} | Success Rate: ${data.killRatio}\nBest Pull: ${data.bestPull}%`,
            inline: false
          });
        });
        
        // Add participant info
        if (performance.stats.participants.length > 0) {
          const participantField = performance.stats.participants.map(p => 
            `${p.character} (${p.server}) - ${p.role}`
          ).join('\n');
          
          embed.addFields({
            name: 'Participants with FFLogs Data',
            value: participantField,
            inline: false
          });
        }
        
        await channel.send({
          content: `**Raid Performance Report**`,
          embeds: [embed]
        });
        
      } catch (error) {
        console.error(`Failed to send logs report for raid ${raidId}:`, error);
      }
    }
  } catch (error) {
    console.error(`Error in auto-fetch logs:`, error);
  }
}

// Schedule auto-fetch of logs after raid
function scheduleLogsFetch(raidId) {
  const raid = raids[raidId];
  if (!raid) return;
  
  const raidTime = new Date(raid.datetime);
  const fetchTime = new Date(raidTime.getTime() + (config.fflogs.updateInterval * 60000));
  const now = new Date();
  
  // Only schedule if the fetch time is in the future
  if (fetchTime > now) {
    const cronExpression = `${fetchTime.getMinutes()} ${fetchTime.getHours()} ${fetchTime.getDate()} ${fetchTime.getMonth() + 1} *`;
    
    cron.schedule(cronExpression, async () => {
      await autoFetchLogsAfterRaid(raidId);
    });
    
    console.log(`Scheduled logs fetch for raid ${raid.name} at ${fetchTime}`);
  }
}

// Create raid event
function createRaid(name, description, datetime, raidType = null, partySize = config.maxPartySize, roles = {}, guideLink = null) {
  const raidId = Date.now().toString();
  
  // Use default raid comp if no specific roles provided
  if (Object.keys(roles).length === 0) {
    roles = {...config.defaultRaidComp};
  }
  
  raids[raidId] = {
    id: raidId,
    name,
    description,
    datetime: new Date(datetime).toISOString(),
    partySize,
    roles: roles || {},
    participants: {},
    waitlist: [],
    remindersSent: [],
    raidType: raidType,
    guideLink: guideLink
  };
  
  saveRaids();
  scheduleReminders(raidId);
  scheduleLogsFetch(raidId);
  return raidId;
}

// Schedule reminders for a raid
function scheduleReminders(raidId) {
  const raid = raids[raidId];
  if (!raid) return;
  
  const raidTime = new Date(raid.datetime);
  
  config.reminderTimes.forEach(reminder => {
    const reminderTime = new Date(raidTime.getTime() - (reminder.minutes * 60000));
    const now = new Date();
    
    // Only schedule if the reminder time is in the future
    if (reminderTime > now && !raid.remindersSent.includes(reminder.name)) {
      const cronExpression = `${reminderTime.getMinutes()} ${reminderTime.getHours()} ${reminderTime.getDate()} ${reminderTime.getMonth() + 1} *`;
      
      cron.schedule(cronExpression, async () => {
        try {
          await sendRaidReminder(raidId, reminder.name);
          raid.remindersSent.push(reminder.name);
          saveRaids();
        } catch (error) {
          console.error(`Error sending reminder for raid ${raidId}:`, error);
        }
      });
      
      console.log(`Scheduled ${reminder.name} reminder for raid ${raid.name} at ${reminderTime}`);
    }
  });
}

// Send raid reminder
async function sendRaidReminder(raidId, reminderType) {
  const raid = raids[raidId];
  if (!raid) return;
  
  const raidEmbed = createRaidEmbed(raid);
  
  // Get participants to mention
  const mentions = Object.keys(raid.participants)
    .map(userId => `<@${userId}>`)
    .join(' ');
  
  // Create reminder message with guide link if available
  let content = `**${reminderType} Reminder** for ${raid.name}! ${mentions}`;
  
  if (raid.guideLink) {
    content += `\n\nDon't forget to study. We are using this guide: ${raid.guideLink}`;
  }
  
  // Find the original message
  if (raid.messageId && raid.channelId) {
    try {
      const channel = await client.channels.fetch(raid.channelId);
      await channel.send({
        content: content,
        embeds: [raidEmbed]
      });
      console.log(`Sent ${reminderType} reminder for raid ${raid.name}`);
    } catch (error) {
      console.error(`Failed to send reminder for raid ${raidId}:`, error);
    }
  }
}

// Sign up for a raid
function signUpForRaid(raidId, userId, username, role) {
  const raid = raids[raidId];
  if (!raid) return { success: false, message: "Raid not found!" };
  
  // Validate role
  if (!config.roles.includes(role)) {
    return { 
      success: false, 
      message: `Invalid role. Please choose from: ${config.roles.join(', ')}` 
    };
  }
  
  // Check if already signed up
  if (raid.participants[userId]) {
    return { success: false, message: `You're already signed up as ${raid.participants[userId].role}` };
  }
  
  // Count participants for the selected role
  const roleCount = Object.values(raid.participants)
    .filter(p => p.role === role)
    .length;
  
  // Check role limits
  const roleLimit = raid.roles[role] || 0;
  if (roleLimit > 0 && roleCount >= roleLimit) {
    // Add to waitlist instead
    raid.waitlist.push({
      userId,
      username,
      role,
      timestamp: new Date().toISOString()
    });
    
    saveRaids();
    return { success: false, message: `Role ${role} is full. You've been added to the waitlist.` };
  }
  
  // Add to participants
  raid.participants[userId] = {
    username,
    role,
    timestamp: new Date().toISOString()
  };
  
  saveRaids();
  return { success: true, message: `You've signed up for ${raid.name} as ${role}` };
}

// Cancel signup
function cancelSignup(raidId, userId) {
  const raid = raids[raidId];
  if (!raid || !raid.participants[userId]) return false;
  
  const role = raid.participants[userId].role;
  delete raid.participants[userId];
  
  // Check waitlist for next person in this role
  const waitlistIndex = raid.waitlist.findIndex(w => w.role === role);
  if (waitlistIndex >= 0) {
    const nextPerson = raid.waitlist.splice(waitlistIndex, 1)[0];
    raid.participants[nextPerson.userId] = {
      username: nextPerson.username,
      role: nextPerson.role,
      timestamp: new Date().toISOString()
    };
  }
  
  saveRaids();
  return true;
}

// Create raid embed
function createRaidEmbed(raid) {
  const raidDate = new Date(raid.datetime);
  
  // Format as Discord timestamp for user's local time
  const discordTimestamp = `<t:${Math.floor(raidDate.getTime() / 1000)}:F>`;
  const relativeTime = `<t:${Math.floor(raidDate.getTime() / 1000)}:R>`;
  
  // Create role breakdown - only show relevant roles
  const roleBreakdown = Object.entries(raid.roles)
    .filter(([role, limit]) => limit > 0)  // Only show roles with slots
    .map(([role, limit]) => {
      const signedUp = Object.values(raid.participants)
        .filter(p => p.role === role)
        .map(p => p.username);
      
      const count = signedUp.length;
      
      return {
        name: `${role} (${count}/${limit})`,
        value: signedUp.length > 0 ? signedUp.join('\n') : 'None',
        inline: true
      };
    });
  
  // Create waitlist field if needed
  const fields = [...roleBreakdown];
  if (raid.waitlist.length > 0) {
    const waitlistField = {
      name: 'Waitlist',
      value: raid.waitlist
        .map(w => `${w.username} (${w.role})`)
        .join('\n'),
      inline: false
    };
    fields.push(waitlistField);
  }
  
  // Add guide link if available
  let description = raid.description;
  if (raid.guideLink) {
    description += `\n\n**Guide:** ${raid.guideLink}`;
  }
  
  // Add raid type if available
  let footer = `Raid ID: ${raid.id}`;
  if (raid.raidType) {
    footer += ` | Type: ${raid.raidType}`;
  }
  
  return new EmbedBuilder()
    .setTitle(raid.name)
    .setDescription(description)
    .addFields(
      { name: 'Date & Time', value: `${discordTimestamp}\n${relativeTime}`, inline: false },
      ...fields
    )
    .setColor('#FF5252')
    .setFooter({ text: footer })
    .setTimestamp();
}

// Create raid signup components
function createRaidComponents(raidId) {
  const signupButton = new ButtonBuilder()
    .setCustomId(`signup_${raidId}`)
    .setLabel('Sign Up')
    .setStyle(ButtonStyle.Primary);
  
  const cancelButton = new ButtonBuilder()
    .setCustomId(`cancel_${raidId}`)
    .setLabel('Cancel Signup')
    .setStyle(ButtonStyle.Danger);
  
  return new ActionRowBuilder().addComponents(signupButton, cancelButton);
}

// Music functionality
// Create a new audio player
function createMusicPlayer(guildId) {
  if (!musicQueues[guildId]) {
    musicQueues[guildId] = {
      queue: [],
      player: createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Pause,
        }
      }),
      connection: null,
      currentSong: null,
      volume: 1.0
    };
    
    // Handle when a song finishes playing
    musicQueues[guildId].player.on(AudioPlayerStatus.Idle, () => {
      musicQueues[guildId].currentSong = null;
      playNextSong(guildId);
    });
    
    // Handle errors
    musicQueues[guildId].player.on('error', error => {
      console.error(`Error in audio player for guild ${guildId}:`, error);
      playNextSong(guildId);
    });
  }
  
  return musicQueues[guildId];
}

// Connect to voice channel
function connectToVoice(message) {
  const voiceChannel = message.member?.voice.channel;
  if (!voiceChannel) {
    message.reply('You need to be in a voice channel to use music commands!');
    return null;
  }
  
  try {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
    });
    
    return connection;
  } catch (error) {
    console.error('Error connecting to voice channel:', error);
    message.reply('Failed to connect to the voice channel.');
    return null;
  }
}

// Play next song in queue
async function playNextSong(guildId) {
  const guildQueue = musicQueues[guildId];
  
  if (!guildQueue || guildQueue.queue.length === 0) {
    // No more songs in queue
    if (guildQueue?.connection) {
      setTimeout(() => {
        // Disconnect after 5 minutes of inactivity
        if (guildQueue.queue.length === 0 && !guildQueue.currentSong) {
          guildQueue.connection.destroy();
          guildQueue.connection = null;
        }
      }, 5 * 60 * 1000);
    }
    return;
  }
  
  const nextSong = guildQueue.queue.shift();
  guildQueue.currentSong = nextSong;
  
  try {
    // Check if URL or search term
    let videoURL = nextSong.url;
    
    // Create audio resource
    const playStream = await stream(videoURL);
    const resource = createAudioResource(playStream.stream, {
      inputType: playStream.type,
      inlineVolume: true
    });
    
    // Set volume
    resource.volume.setVolume(guildQueue.volume);
    
    // Play the song
    guildQueue.player.play(resource);
    
    // Send now playing message to the channel
    if (nextSong.textChannel) {
      const embed = new EmbedBuilder()
        .setTitle('🎵 Now Playing')
        .setDescription(`[${nextSong.title}](${nextSong.url})`)
        .setThumbnail(nextSong.thumbnail)
        .addFields(
          { name: 'Duration', value: nextSong.duration, inline: true },
          { name: 'Requested By', value: nextSong.requestedBy, inline: true }
        )
        .setColor('#1DB954');
        
      nextSong.textChannel.send({ embeds: [embed] });
    }
  } catch (error) {
    console.error(`Error playing song in guild ${guildId}:`, error);
    
    if (nextSong.textChannel) {
      nextSong.textChannel.send(`Error playing: ${nextSong.title}. Skipping to next song...`);
    }
    
    // Skip to next song
    playNextSong(guildId);
  }
}

// Search YouTube for a song
async function searchYouTube(query) {
  try {
    const result = await ytSearch(query);
    
    if (result.videos.length > 0) {
      const video = result.videos[0];
      return {
        title: video.title,
        url: video.url,
        duration: video.duration.timestamp,
        thumbnail: video.thumbnail
      };
    }
    
    return null;
  } catch (error) {
    console.error('Error searching YouTube:', error);
    return null;
  }
}

// Handle button interactions
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  
  const [action, raidId] = interaction.customId.split('_');
  
  if (action === 'signup') {
    const raid = raids[raidId];
    if (!raid) {
      await interaction.reply({ content: 'Raid not found or has been deleted.', ephemeral: true });
      return;
    }
    
    // Create modal for role selection
    const modal = new ModalBuilder()
      .setCustomId(`signupmodal_${raidId}`)
      .setTitle(`Sign up for ${raid.name}`);
    
    // Add role selection dropdown
    const roleInput = new TextInputBuilder()
      .setCustomId('role')
      .setLabel('Select your role')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder(config.roles.join(', '))
      .setRequired(true);
    
    const firstRow = new ActionRowBuilder().addComponents(roleInput);
    modal.addComponents(firstRow);
await interaction.showModal(modal);
  } 
  else if (action === 'cancel') {
    const userId = interaction.user.id;
    const success = cancelSignup(raidId, userId);
    
    if (success) {
      // Update the raid message
      const raid = raids[raidId];
      const raidEmbed = createRaidEmbed(raid);
      const components = createRaidComponents(raidId);
      
      // Try to edit the original message
      if (raid.messageId) {
        try {
          const channel = interaction.channel;
          const message = await channel.messages.fetch(raid.messageId);
          await message.edit({ embeds: [raidEmbed], components: [components] });
        } catch (error) {
          console.error('Failed to update raid message:', error);
        }
      }
      
      await interaction.reply({ content: `You have been removed from the raid.`, ephemeral: true });
    } else {
      await interaction.reply({ content: `You are not signed up for this raid.`, ephemeral: true });
    }
  }
});

// Handle modal submissions
client.on('interactionCreate', async interaction => {
  if (!interaction.isModalSubmit()) return;
  
  if (interaction.customId.startsWith('signupmodal_')) {
    const raidId = interaction.customId.split('_')[1];
    const role = interaction.fields.getTextInputValue('role');
    
    // Validate role
    if (!config.roles.includes(role)) {
      await interaction.reply({ 
        content: `Invalid role. Please choose from: ${config.roles.join(', ')}`, 
        ephemeral: true 
      });
      return;
    }
    
    const result = signUpForRaid(
      raidId, 
      interaction.user.id, 
      interaction.user.username, 
      role
    );
    
    // Update the raid message
    const raid = raids[raidId];
    const raidEmbed = createRaidEmbed(raid);
    const components = createRaidComponents(raidId);
    
    // Try to edit the original message
    if (raid.messageId) {
      try {
        const channel = interaction.channel;
        const message = await channel.messages.fetch(raid.messageId);
        await message.edit({ embeds: [raidEmbed], components: [components] });
      } catch (error) {
        console.error('Failed to update raid message:', error);
      }
    }
    
    await interaction.reply({ content: result.message, ephemeral: true });
  }
});

// Command handler
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!message.content.startsWith(config.prefix)) return;
  
  const args = message.content.slice(config.prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  
  if (command === 'play') {
    // Check if user is in a voice channel
    if (!message.member.voice.channel) {
      return message.reply('You need to be in a voice channel to play music!');
    }
    
    // Get the song query
    const query = args.join(' ');
    if (!query) {
      return message.reply('Please provide a YouTube URL or search term.');
    }
    
    // Create guild queue if it doesn't exist
    const guildQueue = createMusicPlayer(message.guild.id);
    
    // Connect to voice channel if not already connected
    if (!guildQueue.connection) {
      guildQueue.connection = connectToVoice(message);
      
      if (!guildQueue.connection) {
        return; // Error already handled in connectToVoice
      }
      
      // Subscribe to audio player
      guildQueue.connection.subscribe(guildQueue.player);
    }
    
    // Process the song
    try {
      let songInfo;
      
      // Check if URL or search term
      if (ytdl.validateURL(query)) {
        // Get info from URL
        const info = await ytdl.getInfo(query);
        songInfo = {
          title: info.videoDetails.title,
          url: info.videoDetails.video_url,
          duration: formatDuration(info.videoDetails.lengthSeconds),
          thumbnail: info.videoDetails.thumbnails[0].url
        };
      } else {
        // Search YouTube
        message.channel.send(`🔍 Searching for: ${query}`);
        songInfo = await searchYouTube(query);
        
        if (!songInfo) {
          return message.reply('⚠️ No results found for your search.');
        }
      }
      
      // Add song to queue
      guildQueue.queue.push({
        ...songInfo,
        requestedBy: message.author.username,
        textChannel: message.channel
      });
      
      // If not currently playing, start playing
      if (!guildQueue.currentSong) {
        await playNextSong(message.guild.id);
      } else {
        // Otherwise just add to queue
        const embed = new EmbedBuilder()
          .setTitle('🎵 Added to Queue')
          .setDescription(`[${songInfo.title}](${songInfo.url})`)
          .setThumbnail(songInfo.thumbnail)
          .addFields(
            { name: 'Duration', value: songInfo.duration, inline: true },
            { name: 'Position in queue', value: `${guildQueue.queue.length}`, inline: true },
            { name: 'Requested By', value: message.author.username, inline: true }
          )
          .setColor('#1DB954');
          
        message.reply({ embeds: [embed] });
      }
    } catch (error) {
      console.error('Error processing song:', error);
      message.reply('An error occurred while processing your request.');
    }
  }
  else if (command === 'skip') {
    const guildQueue = musicQueues[message.guild.id];
    
    if (!message.member.voice.channel) {
      return message.reply('You need to be in a voice channel to skip songs.');
    }
    
    if (!guildQueue || (!guildQueue.currentSong && guildQueue.queue.length === 0)) {
      return message.reply('There are no songs playing to skip.');
    }
    
    // Skip the current song
    message.channel.send('⏭️ Skipping current song...');
    guildQueue.player.stop();
  }
  else if (command === 'queue') {
    const guildQueue = musicQueues[message.guild.id];
    
    if (!guildQueue || (!guildQueue.currentSong && guildQueue.queue.length === 0)) {
      return message.reply('The music queue is empty.');
    }
    
    let queueString = '';
    
    // Current song
    if (guildQueue.currentSong) {
      queueString += `**Now Playing:**\n[${guildQueue.currentSong.title}](${guildQueue.currentSong.url}) | Requested by: ${guildQueue.currentSong.requestedBy}\n\n`;
    }
    
    // Queue
    if (guildQueue.queue.length > 0) {
      queueString += '**Queue:**\n';
      
      guildQueue.queue.forEach((song, index) => {
        queueString += `${index + 1}. [${song.title}](${song.url}) | Requested by: ${song.requestedBy}\n`;
      });
    }
    
    const embed = new EmbedBuilder()
      .setTitle('🎵 Music Queue')
      .setDescription(queueString)
      .setColor('#1DB954');
      
    message.reply({ embeds: [embed] });
  }
  else if (command === 'stop') {
    const guildQueue = musicQueues[message.guild.id];
    
    if (!message.member.voice.channel) {
      return message.reply('You need to be in a voice channel to stop the music.');
    }
    
    if (!guildQueue || (!guildQueue.currentSong && guildQueue.queue.length === 0)) {
      return message.reply('There is no music playing.');
    }
    
    // Clear the queue
    guildQueue.queue = [];
    guildQueue.player.stop();
    guildQueue.currentSong = null;
    
    // Disconnect from voice
    if (guildQueue.connection) {
      guildQueue.connection.destroy();
      guildQueue.connection = null;
    }
    
    message.reply('⏹️ Music stopped and queue cleared.');
  }
  else if (command === 'raid') {
    const subcommand = args[0]?.toLowerCase();
    
    if (subcommand === 'create') {
      // Format: !raid create "Raid Name" "Raid Description" "YYYY-MM-DD HH:MM" [type] [guide] [roles]
      // Example: !raid create "Eden Savage" "Weekly prog" "2023-12-15 20:00" raid1 "https://guide.com" Tank:2 "Regen Healer":1 "Shield Healer":1 "Melee DPS":2 "Ranged DPS":1 "Caster DPS":1
      
      // Parse the command with quotes support
      let fullCommand = message.content.slice(config.prefix.length + command.length).trim();
      let inQuote = false;
      let segments = [];
      let current = '';
      
      for (let i = 0; i < fullCommand.length; i++) {
        const char = fullCommand[i];
        if (char === '"' && (i === 0 || fullCommand[i-1] !== '\\')) {
          inQuote = !inQuote;
          if (!inQuote) {
            segments.push(current);
            current = '';
          }
        } else if (!inQuote && char === ' ' && current === '') {
          // Skip extra spaces when not in quote
          continue;
        } else if (!inQuote && char === ' ') {
          segments.push(current);
          current = '';
        } else {
          current += char;
        }
      }
      
      if (current) segments.push(current);
      
      // Remove the "create" subcommand
      segments.shift();
      
      // Need at least name, description, and datetime
      if (segments.length < 3) {
        await message.reply('Missing arguments. Format: `!raid create "Raid Name" "Raid Description" "YYYY-MM-DD HH:MM" [type] [guide] [roles]`');
        return;
      }
      
      const name = segments[0];
      const description = segments[1];
      const datetime = segments[2];
      
      // Optional parameters
      let raidType = null;
      let guideLink = null;
      let nextIndex = 3;
      
      // Check if raid type is specified
      if (segments.length > 3 && !segments[3].includes(':')) {
        raidType = segments[3];
        nextIndex = 4;
      }
      
      // Check if guide link is specified (must start with http)
      if (segments.length > nextIndex && (segments[nextIndex].startsWith('http://') || segments[nextIndex].startsWith('https://'))) {
        guideLink = segments[nextIndex];
        nextIndex++;
      }
      
      // Parse roles (optional)
      const roles = {};
      for (let i = nextIndex; i < segments.length; i++) {
        const roleArg = segments[i];
        const [roleName, count] = roleArg.split(':');
        
        if (roleName && count) {
          roles[roleName] = parseInt(count, 10) || 0;
        }
      }
      
      try {
        const raidDate = new Date(datetime);
        if (isNaN(raidDate.getTime())) {
          await message.reply('Invalid date format. Please use YYYY-MM-DD HH:MM');
          return;
        }
        
        const raidId = createRaid(name, description, raidDate, raidType, config.maxPartySize, roles, guideLink);
        const raid = raids[raidId];
        
        // Create and send the raid announcement
        const raidEmbed = createRaidEmbed(raid);
        const components = createRaidComponents(raidId);
        
        const raidMsg = await message.channel.send({
          content: `**New Raid Event!** React to sign up:`,
          embeds: [raidEmbed],
          components: [components]
        });
        
        // Save the message ID for updates
        raid.messageId = raidMsg.id;
        raid.channelId = message.channel.id;
        saveRaids();
        
        await message.reply(`Raid "${name}" created! ID: ${raidId}`);
      } catch (error) {
        console.error('Error creating raid:', error);
        await message.reply('Failed to create raid. Please check your command format.');
      }
    }
    else if (subcommand === 'list') {
      // List all upcoming raids
      const now = new Date();
      const upcomingRaids = Object.values(raids)
        .filter(raid => new Date(raid.datetime) > now)
        .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
      
      if (upcomingRaids.length === 0) {
        await message.reply('No upcoming raids scheduled.');
        return;
      }
      
      const raidList = upcomingRaids.map(raid => {
        const date = new Date(raid.datetime);
        const participantCount = Object.keys(raid.participants).length;
        const timestamp = `<t:${Math.floor(date.getTime() / 1000)}:F>`;
        const typeInfo = raid.raidType ? `[${raid.raidType}] ` : '';
        return `**${typeInfo}${raid.name}** (ID: ${raid.id}) - ${timestamp} - ${participantCount} signed up`;
      }).join('\n');
      
      await message.reply(`**Upcoming Raids:**\n${raidList}`);
    }
    else if (subcommand === 'delete') {
      // Delete a raid by ID
      const raidId = args[1];
      if (!raidId || !raids[raidId]) {
        await message.reply('Raid not found. Use `!raid list` to see available raids.');
        return;
      }
      
      const raid = raids[raidId];
      delete raids[raidId];
      saveRaids();
      
      await message.reply(`Raid "${raid.name}" has been deleted.`);
      
      // Try to edit the original message if possible
      if (raid.messageId && raid.channelId) {
        try {
          const channel = await client.channels.fetch(raid.channelId);
          const raidMsg = await channel.messages.fetch(raid.messageId);
          await raidMsg.edit({
            content: `**CANCELLED: ${raid.name}**`,
            embeds: [],
            components: []
          });
        } catch (error) {
          console.error('Failed to update deleted raid message:', error);
        }
      }
    }
    else if (subcommand === 'pf') {
      // Create a Party Finder link
      // Format: !raid pf "Duty Name" "Description" "Duty Finder Category" "Min iLvl"
      
      if (args.length < 5) {
        await message.reply('Missing arguments. Format: `!raid pf "Duty Name" "Description" "Duty Finder Category" "Min iLvl"`');
        return;
      }
      
      // Parse with quotes
      let fullCommand = message.content.slice(config.prefix.length + command.length + subcommand.length).trim();
      let segments = [];
      let current = '';
      let inQuote = false;
      
      for (let i = 0; i < fullCommand.length; i++) {
        const char = fullCommand[i];
        if (char === '"' && (i === 0 || fullCommand[i-1] !== '\\')) {
          inQuote = !inQuote;
          if (!inQuote) {
            segments.push(current);
            current = '';
          }
        } else if (!inQuote && char === ' ' && current === '') {
          // Skip extra spaces when not in quote
          continue;
        } else if (!inQuote && char === ' ') {
          segments.push(current);
          current = '';
        } else {
          current += char;
        }
      }
      
      if (current) segments.push(current);
      
      const dutyName = segments[0];
      const description = segments[1];
      const category = segments[2];
      const minIlvl = segments[3];
      
      // Create PF embed
      const pfEmbed = new EmbedBuilder()
        .setTitle(`Party Finder: ${dutyName}`)
        .setDescription(description)
        .addFields(
          { name: 'Category', value: category, inline: true },
          { name: 'Minimum iLvl', value: minIlvl, inline: true },
          { name: 'Posted by', value: message.author.username, inline: true }
        )
        .setColor('#FFA500')
        .setTimestamp();
      
      // Create "Join" button
      const joinButton = new ButtonBuilder()
        .setCustomId(`pf_join_${Date.now()}`)
        .setLabel('Join PF')
        .setStyle(ButtonStyle.Success);
      
      const row = new ActionRowBuilder().addComponents(joinButton);
      
      await message.channel.send({
        content: `**New Party Finder Posted!**`,
        embeds: [pfEmbed],
        components: [row]
      });
      
      await message.reply('Party Finder info posted!');
    }
    else if (subcommand === 'schedule') {
      // Setup recurring raids based on config.regularRaids
      // Format: !raid schedule raid1
      const raidTemplateId = args[1];
      
      if (!raidTemplateId || !config.regularRaids[raidTemplateId]) {
        await message.reply(`Invalid raid template. Available templates: ${Object.keys(config.regularRaids).join(', ')}`);
        return;
      }
      
      const template = config.regularRaids[raidTemplateId];
      const now = new Date();
      let scheduledCount = 0;
      
      // Schedule for the next 4 weeks
      for (let i = 0; i < 4; i++) {
        for (const dayName of template.days) {
          // Calculate the date for this day
          const targetDate = new Date(now.getTime());
          const daysToAdd = getDaysToAdd(now.getDay(), dayOfWeek(dayName));
          targetDate.setDate(now.getDate() + daysToAdd + (7 * i));
          
          // Set the time
          const [hours, minutes] = template.time.split(':').map(Number);
          targetDate.setHours(hours, minutes, 0, 0);
          
          // Only schedule if it's in the future
          if (targetDate > now) {
            const dateStr = targetDate.toISOString().split('T')[0];
            const name = `${template.name} - ${dayName}`;
            const description = `Regular ${raidTemplateId} raid on ${dayName}s`;
            
            createRaid(name, description, targetDate, raidTemplateId, config.maxPartySize, {...config.defaultRaidComp});
            scheduledCount++;
          }
        }
      }
      
      await message.reply(`Successfully scheduled ${scheduledCount} instances of ${raidTemplateId} for the next 4 weeks.`);
    }
    else if (subcommand === 'ping') {
      // Send a ping to all participants for a specific raid type
      // Format: !raid ping raid1 [message]
      const raidTypeId = args[1];
      const pingMessage = args.slice(2).join(' ') || 'Attention needed!';
      
      if (!raidTypeId) {
        await message.reply('Please specify a raid type to ping. Format: `!raid ping raid1 [message]`');
        return;
      }
      
      // Find all raids of this type
      const typeRaids = Object.values(raids).filter(raid => raid.raidType === raidTypeId);
      
      if (typeRaids.length === 0) {
        await message.reply(`No raids found with type '${raidTypeId}'.`);
        return;
      }
      
      // Get unique participants across all these raids
      const participants = new Set();
      typeRaids.forEach(raid => {
        Object.keys(raid.participants).forEach(userId => participants.add(userId));
      });
      
      if (participants.size === 0) {
        await message.reply(`No participants found in raids of type '${raidTypeId}'.`);
        return;
      }
      
      // Format pings
      const mentions = Array.from(participants).map(userId => `<@${userId}>`).join(' ');
      await message.channel.send(`**[${raidTypeId}] ${pingMessage}** ${mentions}`);
      
      await message.reply(`Successfully pinged ${participants.size} participants from ${typeRaids.length} raids.`);
    }
    else if (subcommand === 'join') {
      // Join a raid with a specific role
      // Format: !raid join [raidId] [role]
      const raidId = args[1];
      const role = args.slice(2).join(' ');
      
      if (!raidId || !role) {
        await message.reply('Missing arguments. Format: `!raid join [raidId] [role]`');
        return;
      }
      
      if (!raids[raidId]) {
        await message.reply('Raid not found. Use `!raid list` to see available raids.');
        return;
      }
      
      const result = signUpForRaid(raidId, message.author.id, message.author.username, role);
      
      // Update the raid message
      if (result.success) {
        const raid = raids[raidId];
        const raidEmbed = createRaidEmbed(raid);
        const components = createRaidComponents(raidId);
        
        // Try to edit the original message
        if (raid.messageId) {
          try {
            const channel = await client.channels.fetch(raid.channelId);
            const raidMsg = await channel.messages.fetch(raid.messageId);
            await raidMsg.edit({ embeds: [raidEmbed], components: [components] });
          } catch (error) {
            console.error('Failed to update raid message:', error);
          }
        }
      }
      
      await message.reply(result.message);
    }
    else if (subcommand === 'fflogs') {
      // FFLogs commands
      const fflogAction = args[1]?.toLowerCase();
      
      if (fflogAction === 'register') {
        // Format: !raid fflogs register "Character Name" "Server Name" [region]
        // Example: !raid fflogs register "Warrior of Light" "Gilgamesh" na
        
        if (args.length < 4) {
          await message.reply('Missing arguments. Format: `!raid fflogs register "Character Name" "Server Name" [region]`');
          return;
        }
        
        // Parse with quotes
        let fullCommand = message.content.slice(config.prefix.length + command.length + subcommand.length + fflogAction.length).trim();
        let segments = [];
        let current = '';
        let inQuote = false;
        
        for (let i = 0; i < fullCommand.length; i++) {
          const char = fullCommand[i];
          if (char === '"' && (i === 0 || fullCommand[i-1] !== '\\')) {
            inQuote = !inQuote;
            if (!inQuote) {
              segments.push(current);
              current = '';
            }
          } else if (!inQuote && char === ' ' && current === '') {
            // Skip extra spaces when not in quote
            continue;
          } else if (!inQuote && char === ' ') {
            segments.push(current);
            current = '';
          } else {
            current += char;
          }
        }
        
        if (current) segments.push(current);
        
        const characterName = segments[0];
        const serverName = segments[1];
        const region = segments[2] || config.fflogs.region;
        
        if (!characterName || !serverName) {
          await message.reply('Please provide both character name and server name.');
          return;
        }
        
        const statusMsg = await message.reply(`Registering character "${characterName}" on server "${serverName}"...`);
        
        const result = await registerCharacter(message.author.id, characterName, serverName, region);
        
        await statusMsg.edit(result.message);
      }
      else if (fflogAction === 'recent') {
        // Get recent logs for the user's character
        if (!characterLogs[message.author.id] || characterLogs[message.author.id].length === 0) {
          await message.reply('You have no registered characters. Use `!raid fflogs register "Character Name" "Server Name"` to register.');
          return;
        }
        
        const character = characterLogs[message.author.id][0]; // Get primary character
        const count = parseInt(args[2], 10) || 5;
        
        const statusMsg = await message.reply(`Fetching recent logs for ${character.name}...`);
        
        const logs = await getCharacterLogs(character.id, count);
        
        if (!logs.success) {
          await statusMsg.edit(logs.message);
          return;
        }
        
        // Create embed with logs
        const embed = new EmbedBuilder()
          .setTitle(`Recent Logs for ${logs.character.name}`)
          .setDescription(`Server: ${logs.character.server} (${logs.character.region})`)
          .setColor('#FF5252')
          .setTimestamp();
        
        if (logs.reports.length === 0) {
          embed.addFields({
            name: 'No Logs Found',
            value: 'No recent raid logs found for this character.'
          });
        } else {
          logs.reports.forEach(report => {
            embed.addFields({
              name: `${report.title} - ${report.date}`,
              value: `Zone: ${report.zone}\nDuration: ${report.duration}\nPulls: ${report.totalFights} | Kills: ${report.kills}${report.bestPull ? ` | Best Pull: ${report.bestPull}` : ''}\n[View Log](${report.url})`,
              inline: false
            });
          });
        }
        
        await statusMsg.edit({ content: ' ', embeds: [embed] });
      }
      else if (fflogAction === 'static') {
        // Get static performance from a specific raid
        const raidId = args[2];
        
        if (!raidId || !raids[raidId]) {
          await message.reply('Raid not found. Use `!raid list` to see available raids.');
          return;
        }
        
        const statusMsg = await message.reply(`Analyzing static performance for ${raids[raidId].name}...`);
        
        const performance = await getStaticPerformance(raidId);
        
        if (!performance.success) {
          await statusMsg.edit(performance.message);
          return;
        }
        
        // Create embed with performance data
        const embed = new EmbedBuilder()
          .setTitle(`Static Performance: ${performance.stats.raid}`)
          .setDescription(`Raid Date: ${performance.stats.date}`)
          .setColor('#FF5252')
          .setTimestamp();
        
        // Add fields for each zone
        if (Object.keys(performance.stats.zoneAnalysis).length === 0) {
          embed.addFields({
            name: 'No Data Available',
            value: 'No recent raid logs found for participants.'
          });
        } else {
          Object.entries(performance.stats.zoneAnalysis).forEach(([zone, data]) => {
            embed.addFields({
              name: zone,
              value: `Pulls: ${data.totalPulls} | Kills: ${data.totalKills} | Success Rate: ${data.killRatio}\nBest Pull: ${data.bestPull}%`,
              inline: false
            });
          });
        }
        
        // Add participant info
        if (performance.stats.participants.length > 0) {
          const participantField = performance.stats.participants.map(p => 
            `${p.character} (${p.server}) - ${p.role}`
          ).join('\n');
          
          embed.addFields({
            name: 'Participants with FFLogs Data',
            value: participantField,
            inline: false
          });
        }
        
        await statusMsg.edit({ content: ' ', embeds: [embed] });
      }
      else {
        await message.reply('Unknown FFLogs command. Available commands: `register`, `recent`, `static`');
      }
    }
    else {
      // Help command
      const helpEmbed = new EmbedBuilder()
        .setTitle('FFXIV Raid Bot Commands')
        .setDescription('Here are the available commands for the FFXIV Raid Bot:')
        .addFields(
          { 
            name: `${config.prefix}raid create "Raid Name" "Raid Description" "YYYY-MM-DD HH:MM" [type] [guide] [roles]`, 
            value: 'Create a new raid event with optional type, guide link, and role limits'
          },
          { 
            name: `${config.prefix}raid list`, 
            value: 'List all upcoming raids'
          },
          { 
            name: `${config.prefix}raid delete [raid ID]`, 
            value: 'Delete a raid event'
          },
          { 
            name: `${config.prefix}raid pf "Duty Name" "Description" "Duty Finder Category" "Min iLvl"`, 
            value: 'Post Party Finder information'
          },
          { 
            name: `${config.prefix}raid schedule [raid template]`, 
            value: 'Schedule recurring raids for the next 4 weeks'
          },
          { 
            name: `${config.prefix}raid ping [raid type] [message]`, 
            value: 'Ping all participants in raids of a specific type'
          },
          { 
            name: `${config.prefix}raid join [raid ID] [role]`, 
            value: 'Join a raid with a specific role'
          },
          { 
            name: `${config.prefix}raid fflogs register "Character Name" "Server Name"`, 
            value: 'Register your FFXIV character with FFLogs'
          },
          { 
            name: `${config.prefix}play [YouTube URL or search term]`, 
            value: 'Play music from YouTube'
          },
          { 
            name: `${config.prefix}skip`, 
            value: 'Skip to the next song in queue'
          },
          { 
            name: `${config.prefix}queue`, 
            value: 'Show the current music queue'
          },
          { 
            name: `${config.prefix}stop`, 
            value: 'Stop playing music and clear the queue'
          }
        )
        .setColor('#3498DB');
      
      await message.reply({ embeds: [helpEmbed] });
    }
  }
});

// Helper function to format duration
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  } else {
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }
}

// Get day of week as number from name
function dayOfWeek(dayName) {
  const days = { 
    'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3, 
    'thursday': 4, 'friday': 5, 'saturday': 6 
  };
  return days[dayName.toLowerCase()];
}

// Calculate days to add to reach target day
function getDaysToAdd(currentDay, targetDay) {
  return (targetDay + 7 - currentDay) % 7;
}

// Ready event
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  loadRaids();
  loadCharacterLogs();
  
  // Try to get FFLogs token if configured
  if (config.fflogs.clientId && config.fflogs.clientSecret) {
    getFFLogsToken();
  }
  
  // Set bot status
  client.user.setActivity('!raid for help', { type: 'PLAYING' });
});

// Error handling
client.on('error', error => {
  console.error('Client error:', error);
});

process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error);
});

// Login
console.log("Token available:", process.env.TOKEN ? "Yes" : "No");
client.login(process.env.TOKEN);