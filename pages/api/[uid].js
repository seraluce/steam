import { getRelativeTimeImprecise, resolveVanityUrl, getAverage, minutesToHoursPrecise, minutesToHoursCompact, pricePerHour } from '@/utils/utils';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import SteamAPI from 'steamapi';
import * as sidr from 'steamid-resolver';
import moment from 'moment';
import path from 'path';
import axios from 'axios';

// Enhanced caching system
const cache = new Map();
const pendingRequests = new Map(); // Request deduplication

// Cache TTL in milliseconds
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const AVATAR_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const STEAMID_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const GAME_DATA_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

function isCacheValid(timestamp, ttl = CACHE_TTL) {
    return Date.now() - timestamp < ttl;
}

// Pre-load fonts once
let fontsLoaded = false;
function ensureFontsLoaded() {
    if (!fontsLoaded) {
        GlobalFonts.registerFromPath(path.join(process.cwd(), 'public', 'GeistVF.woff2'), 'Geist');
        GlobalFonts.registerFromPath(path.join(process.cwd(), 'public', 'Elgraine-Black-Italic.ttf'), 'Elgraine');
        fontsLoaded = true;
    }
}

async function getUserData(uid) {
    // Check cache first
    const cacheKey = `user_${uid}`;
    const cached = cache.get(cacheKey);
    if (cached && isCacheValid(cached.timestamp)) {
        return cached.data;
    }

    // Check for pending request to avoid duplicate API calls
    if (pendingRequests.has(cacheKey)) {
        return pendingRequests.get(cacheKey);
    }

    const requestPromise = (async () => {
        try {
            let steamId = cache.get(`steamid_${uid}`);
            const steamIdCached = cache.get(`steamid_meta_${uid}`);
            
            if (!steamId || !steamIdCached || !isCacheValid(steamIdCached.timestamp, STEAMID_CACHE_TTL)) {
                steamId = await resolveVanityUrl(uid);
                cache.set(`steamid_${uid}`, steamId);
                cache.set(`steamid_meta_${uid}`, { timestamp: Date.now() });
            }

            const sapi = new SteamAPI(process.env.STEAM_API_KEY);

            // Use Promise.allSettled to handle potential failures gracefully
            const [userSummaryResult, sidrSummaryResult] = await Promise.allSettled([
                sapi.getUserSummary(steamId),
                sidr.steamID64ToFullInfo(steamId)
            ]);

            const userSummary = userSummaryResult.status === 'fulfilled' ? userSummaryResult.value : null;
            const sidrSummary = sidrSummaryResult.status === 'fulfilled' ? sidrSummaryResult.value : {};

            if (!userSummary) {
                throw new Error('Failed to fetch user summary');
            }

            const userData = {
                steamId: steamId,
                personaName: userSummary.nickname,
                visible: userSummary.visible,
                avatar: userSummary.avatar.large,
                lastLogOff: userSummary.lastLogOffTimestamp,
                createdAt: userSummary.createdTimestamp,
                countryCode: userSummary.countryCode,
                stateCode: userSummary.stateCode,
                onlineState: sidrSummary.onlineState ? sidrSummary.onlineState[0] : null,
                location: sidrSummary.location ? sidrSummary.location[0] : 'Unknown',
            };

            // Cache the result
            cache.set(cacheKey, { data: userData, timestamp: Date.now() });
            
            return userData;
        } catch (e) {
            console.error('getUserData error:', e);
            return { error: 'no user' };
        } finally {
            pendingRequests.delete(cacheKey);
        }
    })();

    pendingRequests.set(cacheKey, requestPromise);
    return requestPromise;
}

async function getGameData(uid, countryCode) {
    // Check cache first
    const cacheKey = `games_${uid}_${countryCode}`;
    const cached = cache.get(cacheKey);
    if (cached && isCacheValid(cached.timestamp, GAME_DATA_CACHE_TTL)) {
        return cached.data;
    }

    // Check for pending request
    if (pendingRequests.has(cacheKey)) {
        return pendingRequests.get(cacheKey);
    }

    const requestPromise = (async () => {
        try {
            let steamId = cache.get(`steamid_${uid}`);
            if (!steamId) {
                steamId = await resolveVanityUrl(uid);
                cache.set(`steamid_${uid}`, steamId);
            }

            const sapi = new SteamAPI(process.env.STEAM_API_KEY);

            const userGames = await sapi.getUserOwnedGames(steamId, {
                includeExtendedAppInfo: true,
                includeFreeGames: true,
                includeFreeSubGames: true,
                includeUnvettedApps: true
            });

            // Get appIds and played/unplayed game counts
            let gameIds = [];
            let playtime = [];
            let playedCount = 0;
            let unplayedCount = 0;
            let totalPlaytime = 0;
            for (const item of userGames) {
                gameIds.push(item.game.id);
                if (item.minutes > 0) {
                    playedCount++;
                    playtime.push(item.minutes);
                    totalPlaytime += item.minutes;
                }
                if (item.minutes === 0) unplayedCount++;
            }

            // Optimize pricing API calls - use smaller chunks and add timeout
            const maxGameIdsPerCall = 200; // Reduced chunk size for better reliability
            const gameIdChunks = [];
            for (let i = 0; i < gameIds.length; i += maxGameIdsPerCall) {
                gameIdChunks.push(gameIds.slice(i, i + maxGameIdsPerCall));
            }

            // Make HTTP calls with timeout and error handling
            let prices = [];
            let totalInitial = 0;
            let totalFinal = 0;
            
            await Promise.allSettled(gameIdChunks.map(async (chunk) => {
                try {
                    const chunkString = chunk.join(',');
                    const gamePrices = await axios.get(
                        `https://store.steampowered.com/api/appdetails?appids=${chunkString}&filters=price_overview&cc=${countryCode}`,
                        { timeout: 10000 } // 10 second timeout
                    );

                    // Process response data for each chunk
                    // eslint-disable-next-line no-unused-vars
                    for (const [_, gameData] of Object.entries(gamePrices.data)) {
                        if (gameData.data && gameData.data.price_overview) {
                            const finalPrice = gameData.data.price_overview.final || 0;
                            const initialPrice = gameData.data.price_overview.initial || 0;

                            if (initialPrice > 0) {
                                prices.push(initialPrice);
                                totalInitial += initialPrice;
                                totalFinal += finalPrice;
                            }
                        }
                    }
                } catch (error) {
                    console.warn(`Failed to fetch pricing for chunk: ${error.message}`);
                    // Continue with other chunks even if one fails
                }
            }));

            // Format totals
            const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
            const totalInitialFormatted = formatter.format(totalInitial / 100);
            const totalFinalFormatted = formatter.format(totalFinal / 100);
            const averageGamePrice = prices.length > 0 ? formatter.format(getAverage(prices) / 100) : '$0.00';
            const totalPlaytimeHours = minutesToHoursCompact(totalPlaytime);
            const averagePlaytime = playtime.length > 0 ? minutesToHoursPrecise(getAverage(playtime)) : '0';
            const totalGames = userGames.length;

            const gameData = {
                totals: { totalInitialFormatted, totalFinalFormatted, averageGamePrice, totalPlaytimeHours, averagePlaytime, totalGames },
                playCount: { playedCount, unplayedCount, totalPlaytime }
            };

            // Cache the result
            cache.set(cacheKey, { data: gameData, timestamp: Date.now() });
            
            return gameData;
        } catch (e) {
            console.error('getGameData error:', e);
            return { error: 'private games' };
        } finally {
            pendingRequests.delete(cacheKey);
        }
    })();

    pendingRequests.set(cacheKey, requestPromise);
    return requestPromise;
}

// Cache for loaded images
const imageCache = new Map();

async function getCachedImage(imagePath, isAvatar = false) {
    const cacheKey = `img_${imagePath}`;
    const cached = imageCache.get(cacheKey);
    const ttl = isAvatar ? AVATAR_CACHE_TTL : CACHE_TTL;
    
    if (cached && isCacheValid(cached.timestamp, ttl)) {
        return cached.image;
    }

    try {
        const image = await loadImage(imagePath);
        imageCache.set(cacheKey, { image, timestamp: Date.now() });
        return image;
    } catch (error) {
        console.error(`Failed to load image ${imagePath}:`, error);
        throw error;
    }
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400');

    const {
        uid,
        country_code = 'US',
        bg_color,
        title_color,
        sub_title_color,
        text_color,
        username_color,
        id_color,
        cp_color,
        ip_color,
        div_color,
        border_color,
        border_width,
        progbar_bg,
        progbar_color,
        hide_border,
        theme
    } = req.query;

    try {
        // Ensure fonts are loaded
        ensureFontsLoaded();

        const [userData, gameData] = await Promise.all([
            getUserData(uid), 
            getGameData(uid, country_code)
        ]);

        const canvasBuffer = await createFullCanvas(
            userData,
            gameData,
            bg_color,
            title_color,
            sub_title_color,
            text_color,
            username_color,
            id_color,
            cp_color,
            ip_color,
            div_color,
            border_color,
            border_width,
            progbar_bg,
            progbar_color,
            hide_border,
            theme
        );

        res.setHeader('Content-Type', 'image/png');
        res.status(200).send(canvasBuffer);
    } catch (error) {
        console.error('Handler error:', error);
        res.status(500).json({ error: 'Failed to generate image' });
    }
}

async function createFullCanvas(
    userData,
    gameData,
    bg_color = '0b0b0b',
    title_color = 'fff',
    sub_title_color = 'adadad',
    text_color = 'fff',
    username_color = 'fff',
    id_color = 'adadad',
    cp_color = 'f87171',
    ip_color = '4ade80',
    div_color = 'ffffff30',
    border_color = 'ffffff30',
    border_width = 1,
    progbar_bg = '313131',
    progbar_color = '006fee',
    hide_border = false,
    theme
) {
    // Themes
    // Dark
    if (theme === 'dark') bg_color = '0b0b0b';
    if (theme === 'dark') title_color = 'fff';
    if (theme === 'dark') sub_title_color = 'adadad';
    if (theme === 'dark') text_color = 'fff';
    if (theme === 'dark') username_color = 'fff';
    if (theme === 'dark') id_color = 'adadad';
    if (theme === 'dark') div_color = 'ffffff30';
    if (theme === 'dark') border_color = 'ffffff30';
    if (theme === 'dark') progbar_bg = 'ffffff30';
    if (theme === 'dark') progbar_color = '006fee';
    // Light
    if (theme === 'light') bg_color = 'fff';
    if (theme === 'light') title_color = '000';
    if (theme === 'light') sub_title_color = '000';
    if (theme === 'light') text_color = '000';
    if (theme === 'light') username_color = '000';
    if (theme === 'light') id_color = 'adadad';
    if (theme === 'light') div_color = '00000030';
    if (theme === 'light') border_color = '00000030';
    if (theme === 'light') progbar_bg = '00000050';
    if (theme === 'light') progbar_color = '60a5fa';

    // Canvas
    const width = 705;
    const height = 385;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = `#${bg_color}`;
    ctx.fillRect(0, 0, width, height);

    // Watermark
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = '#737373';
    ctx.font = '16px Geist';
    ctx.fillText('steeeam.vercel.app', canvas.width - 155, canvas.height - 17);
    const watermarkImage = await getCachedImage(path.join(process.cwd(), 'public', 'canvas', 'steeeam-canvas.png'));
    ctx.drawImage(watermarkImage, canvas.width - 180, canvas.height - 32);
    ctx.globalAlpha = 1;

    // Username (truncated if too long)
    ctx.fillStyle = `#${username_color}`;
    ctx.font = '700 20px Geist';
    let username = userData.personaName;
    const usernameWidth = ctx.measureText(username).width;
    if (usernameWidth > 180) {
        let truncatedLength = 0;
        for (let i = 0; i < username.length; i++) {
            let truncatedText = username.slice(0, i) + '...';
            let textWidth = ctx.measureText(truncatedText).width;
            if (textWidth > 180) {
                break;
            }
            truncatedLength = i;
        }
        const truncatedUsername = username.slice(0, truncatedLength) + '...';
        ctx.fillText(truncatedUsername, 20, 180);
    } else {
        ctx.fillText(username, 20, 180);
    }

    // SteamID
    ctx.fillStyle = `#${id_color}`;
    ctx.font = '10px Geist';
    const steamId = userData.steamId;
    ctx.fillText(steamId, 20, 195);

    // Location
    const locIcon = await getCachedImage(path.join(process.cwd(), 'public', 'canvas', 'loc-icon.png'));
    ctx.drawImage(locIcon, 20, 220);
    ctx.fillStyle = `#${text_color}`;
    ctx.font = '12px Geist';
    let location = userData.location || 'Unknown';
    if (location.length > 22) location = location.slice(0, 22) + '...';
    ctx.fillText(location, 43, 232);

    // Last seen
    const seenIcon = await getCachedImage(path.join(process.cwd(), 'public', 'canvas', 'seen-icon.png'));
    ctx.drawImage(seenIcon, 20, 245);
    ctx.fillStyle = `#${text_color}`;
    ctx.font = '12px Geist';
    const lastSeen = `Last seen ${userData.lastLogOff ? moment.unix(userData.lastLogOff).fromNow() : 'never'}`;
    ctx.fillText(lastSeen, 43, 257);

    // Created at
    const joinIcon = await getCachedImage(path.join(process.cwd(), 'public', 'canvas', 'join-icon.png'));
    ctx.drawImage(joinIcon, 20, 270);
    ctx.fillStyle = `#${text_color}`;
    ctx.font = '12px Geist';
    const createdAt = `${userData.createdAt ? `Joined ${getRelativeTimeImprecise(userData.createdAt)} ago` : 'Unknown'}`;
    ctx.fillText(createdAt, 43, 283);

    // Vertical divider
    ctx.lineWidth = 1;
    ctx.strokeStyle = `#${div_color}`;
    ctx.beginPath();
    ctx.moveTo(200, 15);
    ctx.lineTo(200, canvas.height - 15);
    ctx.stroke();

    // Account stats header
    const gameStatsIcon = await getCachedImage(path.join(process.cwd(), 'public', 'canvas', 'game-stats-icon.png'));
    ctx.drawImage(gameStatsIcon, 215, 20);
    ctx.fillStyle = `#${title_color}`;
    ctx.font = '600 16px Geist';
    const gameStatsHeader = 'Account Statistics';
    ctx.fillText(gameStatsHeader, 245, 37);

    // Horizontal divider
    ctx.lineWidth = 1;
    ctx.strokeStyle = `#${div_color}`;
    ctx.beginPath();
    ctx.moveTo(215, 50);
    ctx.lineTo(canvas.width - 15, 50);
    ctx.stroke();

    if (!gameData.error) {
        // Account value
        // Current
        ctx.fillStyle = `#${sub_title_color}`;
        ctx.font = '16px Geist';
        ctx.fillText('Current Price', 215, 80);
        ctx.fillStyle = `#${cp_color}`;
        ctx.font = '600 26px Geist';
        ctx.fillText(`${gameData.totals?.totalFinalFormatted || '$0'}`, 215, 110);
        //Initial
        ctx.fillStyle = `#${sub_title_color}`;
        ctx.font = '16px Geist';
        ctx.fillText('Initial Price', 370, 80);
        ctx.fillStyle = `#${ip_color}`;
        ctx.font = '600 26px Geist';
        ctx.fillText(`${gameData.totals?.totalInitialFormatted || '$0'}`, 370, 110);

        // Game stats
        // Total games
        ctx.fillStyle = `#${sub_title_color}`;
        ctx.font = '16px Geist';
        ctx.fillText('Total Games', 215, 160);
        ctx.fillStyle = `#${text_color}`;
        ctx.font = '600 26px Geist';
        ctx.fillText(`${gameData.totals?.totalGames || '0'}`, 215, 190);
        // Average price
        ctx.fillStyle = `#${sub_title_color}`;
        ctx.font = '16px Geist';
        ctx.fillText('Avg. Price', 370, 160);
        ctx.fillStyle = `#${text_color}`;
        ctx.font = '600 26px Geist';
        ctx.fillText(`${gameData.totals?.averageGamePrice || '$0'}`, 370, 190);
        // Price per hour
        ctx.fillStyle = `#${sub_title_color}`;
        ctx.font = '16px Geist';
        ctx.fillText('Price Per Hour', 510, 160);
        ctx.fillStyle = `#${text_color}`;
        ctx.font = '600 26px Geist';
        ctx.fillText(`${pricePerHour(gameData.totals?.totalFinalFormatted, gameData.totals?.totalPlaytimeHours) || '0'}`, 510, 190);
        // Average playtime
        ctx.fillStyle = `#${sub_title_color}`;
        ctx.font = '16px Geist';
        ctx.fillText('Avg. Playtime', 215, 240);
        ctx.fillStyle = `#${text_color}`;
        ctx.font = '600 26px Geist';
        ctx.fillText(`${gameData.totals?.averagePlaytime || '0'}h`, 215, 270);
        // Total playtime
        ctx.fillStyle = `#${sub_title_color}`;
        ctx.font = '16px Geist';
        ctx.fillText('Total Playtime', 370, 240);
        ctx.fillStyle = `#${text_color}`;
        ctx.font = '600 26px Geist';
        ctx.fillText(`${gameData.totals?.totalPlaytimeHours || '0'}h`, 370, 270);

        // Game progress bar
        const playedCount = gameData.playCount?.playedCount.toString() || '0';
        const gameCount = gameData.totals?.totalGames.toString() || '0';
        const progressPercent = ((parseInt(playedCount) / parseInt(gameCount)) * 100).toFixed(0);
        if (!isNaN(progressPercent)) {
            ctx.fillStyle = `#${progbar_color}`;
            ctx.font = '700 14px Geist';
            ctx.fillText(playedCount, 215, 324);
            ctx.fillStyle = `#${text_color}`;
            ctx.font = '14px Geist';
            ctx.fillText('/', (ctx.measureText(playedCount).width + 215) + 5, 324);
            ctx.fillStyle = `#${progbar_color}`;
            ctx.font = '700 14px Geist';
            ctx.fillText(gameCount, (ctx.measureText(playedCount).width + 215) + 15, 324);
            ctx.fillStyle = `#${text_color}`;
            ctx.font = '14px Geist';
            ctx.fillText('games played', (ctx.measureText(playedCount).width + ctx.measureText(gameCount).width) + 215 + 20, 324);
            ctx.font = '700 14px Geist';
            ctx.fillText(`${progressPercent}%`, 405, 324);
        }

        async function createRoundedProgressBar(barwidth, barheight, progress, barColor, backgroundColor, borderRadius) {
            if (isNaN(progress)) return;
            ctx.fillStyle = backgroundColor;
            roundRect(ctx, 215, 330, barwidth, barheight, borderRadius, true, false);
            const barWidth = Math.floor(barwidth * (progress / 100));
            ctx.fillStyle = barColor;
            roundRect(ctx, 215, 330, barWidth, barheight, borderRadius, true, true);
        }

        async function roundRect(ctx, x, y, width, height, radius, fill, stroke) {
            if (typeof stroke === 'undefined') {
                stroke = true;
            }
            if (typeof radius === 'undefined') {
                radius = 5;
            }
            ctx.beginPath();
            ctx.moveTo(x + radius, y);
            ctx.lineTo(x + width - radius, y);
            ctx.arcTo(x + width, y, x + width, y + radius, radius);
            ctx.lineTo(x + width, y + height - radius);
            ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius);
            ctx.lineTo(x + radius, y + height);
            ctx.arcTo(x, y + height, x, y + height - radius, radius);
            ctx.lineTo(x, y + radius);
            ctx.arcTo(x, y, x + radius, y, radius);
            ctx.closePath();
            if (stroke) {
                ctx.stroke();
            }
            if (fill) {
                ctx.fill();
            }
        }
        const barwidth = 220;
        const barheight = 12;
        const progress = (parseInt(playedCount) / parseInt(gameCount)) * 100;
        const barColor = `#${progbar_color}`;
        const backgroundColor = `#${progbar_bg}`;
        const borderRadius = 6;
        await createRoundedProgressBar(barwidth, barheight, progress, barColor, backgroundColor, borderRadius);
    } else {
        ctx.fillStyle = `#${sub_title_color}`;
        ctx.font = '16px Geist';
        ctx.fillText('Private Games List', 390, 200);
    }

    // Avatar with caching
    async function drawCenteredRoundedImage() {
        try {
            const avatar = await getCachedImage(userData.avatar, true);
            const desiredWidth = 130;
            const desiredHeight = 130;
            const scaleFactor = Math.min(desiredWidth / avatar.width, desiredHeight / avatar.height);
            const newWidth = avatar.width * scaleFactor;
            const newHeight = avatar.height * scaleFactor;
            ctx.save();
            ctx.beginPath();
            const cornerRadius = newWidth / 2;
            const x = 35;
            const y = 20;
            ctx.moveTo(x + cornerRadius, y);
            ctx.arcTo(x + newWidth, y, x + newWidth, y + newHeight, cornerRadius);
            ctx.arcTo(x + newWidth, y + newHeight, x, y + newHeight, cornerRadius);
            ctx.arcTo(x, y + newHeight, x, y, cornerRadius);
            ctx.arcTo(x, y, x + newWidth, y, cornerRadius);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(avatar, x, y, newWidth, newHeight);
            ctx.restore();
        } catch (error) {
            console.warn('Failed to load avatar, using fallback');
            // Could implement a fallback avatar here
        }
    }
    
    if (userData.avatar && !userData.error) {
        await drawCenteredRoundedImage();
    }

    // Draw border
    if (hide_border !== 'true') {
        ctx.strokeStyle = `#${border_color}`;
        ctx.lineWidth = parseInt(border_width >= 10 ? 10 : border_width);
        ctx.strokeRect(0, 0, canvas.width, canvas.height);
    }

    const buffer = canvas.toBuffer('image/png');
    return buffer;
}
