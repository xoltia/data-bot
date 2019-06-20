require('dotenv').config();
const Discord = require('discord.js');
const DataStore = require('nedb');
const fs = require('fs');
const path = require('path');
const https = require('https');

const client = new Discord.Client();
const db = new DataStore({ filename: 'vc-sessions.db', autoload: true });

if (!fs.existsSync(path.join(__dirname, '/recordings'))) {
    fs.mkdirSync(path.join(__dirname, '/recordings'));
}

let mainVc;
const sessions = {};
const commands = {
    "tts": function(message, args) {
        if (args.length < 2) {
            return message.channel.send("Generic error message");
        }
        const data = JSON.stringify({ voice: args[0], text: args.slice(1, args.length).join(' ') });
        const req = https.request({
            hostname: 'us-central1-sunlit-context-217400.cloudfunctions.net',
            path: '/streamlabs-tts',
            port: '443',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (!mainVc) {
                    return message.channel.send("Not in VC");
                }
                mainVc.play(JSON.parse(data).speak_url);
            });
        });
        req.write(data);
    },
    "info": function(message, args) {
        db.find({}, (err, docs) => {
            message.channel.send(`The bot started recording on ${new Date(docs[0].joinTime)}`);
        });
    },
    "vc-duration": function(message, args) {
        const sessionPromise = sessions[message.author.id];
        if (!sessionPromise) {
            return message.channel.send("You're not currently in a voice channel.");
        }

        sessionPromise.then(_id => {
            db.findOne({_id}, (err, doc) => {
                const time = Date.now();
                const elapsed = (time - doc.joinTime) / 1000;
                message.channel.send(`You have been in your current voice channel for ${elapsed} seconds (${(elapsed/60).toFixed(2)} minutes.)`);
            });
        });
    },
    "vc-stats": function(message, args) {
        const mention = message.mentions.users.first();
        db.find({ member: mention ? mention.id : message.author.id }, (err, docs) => {
            if (err) {
                console.log(err);
                return message.channel.send('An error has occurred.');
            }
            if (docs.length === 0) {
                return message.channel.send(`I've never seen ${mention ? 'you' : 'them'} in a voice channel.`);
            }

            const stats = {};
            docs.map((session) => {
                const start = session.joinTime;
                const end = session.leaveTime || Date.now();
                const channelId = session.channel;
                const guildWithChannel = client.guilds.find(g => g.channels.some(c => c.id === channelId));
                const channelName = guildWithChannel ? guildWithChannel.channels.find(c => c.id === channelId).name : "unknown";

                if (channelId in stats) {
                    stats[channelId].value += end - start;
                } else {
                    stats[channelId] = { name: channelName, value: end - start };
                }
                return session;
            });
            message.channel.send(new Discord.MessageEmbed({
                fields: Object.values(stats)
                    .sort((a, b) => b.value - a.value)
                    .map((field) => {
                        field.value = (field.value / 1000 / 60).toFixed(2) + ' minutes';
                        return field;
                    }),
                color: 0xFF69B4,
                timestamp: Date.now(),
                author: {
                    name: mention ? mention.username : message.author.username,
                    icon_url: mention ? mention.avatarURL : message.author.avatarURL
                }
            }));
        });
    }
}

function makeSession(current) {
    return new Promise((resolve, reject) => {
        db.insert({
            joinTime: Date.now(),
            leaveTime: null,
            member: current.id,
            channel: current.channelID
        }, (err, doc) => {
                if (err) {
                    return reject(err);
                }
                resolve(doc._id);
            });
    });
}

function handleClose() {
    db.update({ leaveTime: null }, { $set: { leaveTime: Date.now() } }, { multi: true }, (err, num, upsert) => {
        if (err) {
            console.log('Error while closing sessions:', err);
        }
        console.log(`Finished ${num} sessions.`)
        process.exit();
    });
}

client.on('ready', () => {
    if (process.env.MAIN_VC) {
        client.channels.find(c => c.id === process.env.MAIN_VC).join().then(conn => {
            mainVc = conn;
            conn.on('speaking', (user, speaking) => {
                if (speaking) {
                    const output = fs.createWriteStream(path.join(__dirname, `/recordings/${user.id}-${conn.channel.id}.pcm`), { flags: 'a' });
                    const audio = conn.receiver.createStream(user, { mode: 'pcm' });
                    audio.pipe(output);
                }
            });
        });
    }
    client.user.setPresence({
        status: process.env.STATUS || 'online',
        game: {
            name: process.env.GAME_NAME || '',
            type: process.env.GAME_TYPE || 'PLAYING',
        },
    });
    client.guilds.forEach(guild => {
        guild.members.forEach(member => {
            if (member.voice.channelID) {
                sessions[member.id] = makeSession(member);
            }
        });
    });
});

client.on('voiceStateUpdate', (old, current) => {
    if (old.channelID !== current.channelID) {
        if (old.channelID) {
            sessions[current.id].then(_id => {
                db.update({_id}, { $set: { leaveTime: Date.now() } });
            })
        }
        if (current.channelID) {
            sessions[current.id] = makeSession(current);
        }
    }
});

client.on('disconnect', () => {
    console.log('Client disconnected, closing sessions.')
    handleClose();
});

process.on('SIGINT', () => {
    console.log('SIGINT received, closing sessions.')
    handleClose();
});

client.on('message', (message) => {
    if (message.author.bot) {
        return;
    }

    if (message.content.charAt(0) === '>') {
        handleCommand(message, message.content.slice(1).split(' ').map(arg => arg.trim()));
    }
});

function handleCommand(message, args) {
    if (args.legnth < 1) {
        return message.channel.send('No command provided.');
    }

    if (args[0] in commands) {
        /*if (!(message.channel instanceof Discord.DMChannel || message.channel.name === "commands")) {
            return message.channel.send('Commands must be in a channel labeled "commands" or in a DM channel.');
        }*/
        commands[args[0]](message, args.slice(1));
    } else {
        message.channel.send('Invalid command.');
    }
}

client.login(process.env.BOT_TOKEN);
