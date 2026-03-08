import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { XMLParser } from 'fast-xml-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// WFMU live stream URLs — use x-rincon-mp3radio:// protocol for Sonos
const LIVE_STREAMS = {
  freeform: 'x-rincon-mp3radio://stream0.wfmu.org/freeform-128k',
  rock:     'x-rincon-mp3radio://stream0.wfmu.org/rocknsoul',
  drummer:  'x-rincon-mp3radio://stream0.wfmu.org/drummer',
  sheena:   'x-rincon-mp3radio://stream0.wfmu.org/sheena'
};

const WFMU_RSS = 'https://wfmu.org/archivefeed/mp3.xml';
const PLAYLISTS_URL = 'https://wfmu.org/recentarchives.php';

/**
 * WFMU Radio Agent — Browse and play WFMU archives and live streams on Sonos
 */
export default class WfmuAgent {
  constructor(config = {}) {
    this.config = config;
    this.xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

    // Speaker cache
    this.speakerCache = null;
    this.speakerCacheTime = 0;
    this.speakerCacheTTL = 60_000; // 60 seconds

    // Show code cache
    this.showCodeCache = null;

    // Lazy-loaded sonos module
    this._sonos = null;
  }

  /**
   * Lazy-load the sonos module (it does heavy UPnP setup on import)
   */
  async getSonosModule() {
    if (!this._sonos) {
      this._sonos = await import('sonos');
    }
    return this._sonos;
  }

  // ── Internal helpers ──

  /**
   * Discover Sonos speakers on the LAN. Cached with TTL.
   */
  async discoverSpeakers() {
    const now = Date.now();
    if (this.speakerCache && (now - this.speakerCacheTime) < this.speakerCacheTTL) {
      return this.speakerCache;
    }

    const sonos = await this.getSonosModule();
    const DeviceDiscovery = sonos.AsyncDeviceDiscovery || sonos.DeviceDiscovery;

    try {
      const discovery = new DeviceDiscovery();
      const device = await discovery.discover({ timeout: 5000 });

      // Get all zone group members
      const groups = await device.getAllGroups();
      const speakers = [];

      for (const group of groups) {
        for (const member of (group.ZoneGroupMember || [])) {
          const memberDevice = new sonos.Sonos(new URL(member.Location).hostname);
          let name;
          try {
            const attrs = await memberDevice.deviceDescription();
            name = attrs.roomName || attrs.friendlyName || member.ZoneName || 'Unknown';
          } catch {
            name = member.ZoneName || 'Unknown';
          }
          speakers.push({
            name,
            ip: new URL(member.Location).hostname,
            uuid: member.UUID
          });
        }
      }

      this.speakerCache = speakers;
      this.speakerCacheTime = now;
      return speakers;
    } catch (err) {
      console.error('[wfmu] Speaker discovery failed:', err.message);
      if (this.speakerCache) return this.speakerCache;
      return [];
    }
  }

  /**
   * Get a Sonos device by speaker name
   */
  async getSpeaker(name) {
    const sonos = await this.getSonosModule();
    const speakers = await this.discoverSpeakers();
    const match = speakers.find(s =>
      s.name.toLowerCase() === name.toLowerCase()
    );
    if (!match) {
      throw new Error(`Speaker "${name}" not found. Available: ${speakers.map(s => s.name).join(', ')}`);
    }
    return new sonos.Sonos(match.ip);
  }

  /**
   * Fetch and parse an RSS feed. Returns array of episodes.
   */
  async fetchFeed(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
    const xml = await res.text();
    const parsed = this.xmlParser.parse(xml);

    const channel = parsed?.rss?.channel;
    if (!channel) return [];

    const items = Array.isArray(channel.item) ? channel.item : (channel.item ? [channel.item] : []);
    return items.map(item => ({
      title: item.title || '',
      link: item.enclosure?.['@_url'] || item.link || '',
      description: (item.description || '').replace(/<[^>]*>/g, '').substring(0, 200),
      pubDate: item.pubDate || '',
      duration: item['itunes:duration'] || ''
    }));
  }

  /**
   * Resolve an M3U URL to the actual MP3 stream URL.
   */
  async resolveM3u(url) {
    if (url.match(/\.(mp3|ogg|aac|flac|wav)(\?|$)/i)) {
      return url;
    }

    try {
      const res = await fetch(url, { redirect: 'follow' });
      const contentType = res.headers.get('content-type') || '';

      if (contentType.includes('mpegurl') || contentType.includes('x-scpls') || url.endsWith('.m3u')) {
        const text = await res.text();
        const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        if (lines.length > 0 && lines[0].startsWith('http')) {
          return lines[0];
        }
      }

      const finalUrl = res.url;
      if (finalUrl.match(/\.(mp3|ogg|aac|flac|wav)(\?|$)/i)) {
        return finalUrl;
      }

      if (contentType.includes('audio/')) {
        return url;
      }

      return url;
    } catch {
      return url;
    }
  }

  /**
   * Scrape show codes from wfmu.org/playlists. Cached in memory.
   */
  async fetchShowCodes() {
    if (this.showCodeCache) return this.showCodeCache;

    try {
      const res = await fetch(PLAYLISTS_URL);
      if (!res.ok) throw new Error(`Playlists page fetch failed: ${res.status}`);
      const html = await res.text();

      const shows = [];
      // Structure: <a href="/playlists/XX" class="show-title-link">Show Name</a>
      const regex = /href="\/playlists\/([A-Za-z0-9]{2})" class="show-title-link">([^<]+)/g;
      let match;
      while ((match = regex.exec(html)) !== null) {
        shows.push({ code: match[1], name: match[2].trim() });
      }

      const seen = new Set();
      this.showCodeCache = shows.filter(s => {
        if (seen.has(s.code)) return false;
        seen.add(s.code);
        return true;
      });

      return this.showCodeCache;
    } catch (err) {
      console.error('[wfmu] Failed to fetch show codes:', err.message);
      return [];
    }
  }

  // ── Express routes ──

  attach(router) {
    router.get('/icon.svg', (req, res) => {
      res.set('Content-Type', 'image/svg+xml');
      res.sendFile(path.join(__dirname, 'icon.svg'));
    });

    router.get('/widget', (req, res) => {
      res.sendFile(path.join(__dirname, 'client/widget.html'));
    });

    router.use('/client', express.static(path.join(__dirname, 'client')));

    // ── API ──

    router.get('/api/speakers', async (req, res) => {
      try {
        const speakers = await this.discoverSpeakers();
        res.json(speakers);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    router.get('/api/shows', async (req, res) => {
      try {
        const shows = await this.fetchShowCodes();
        res.json(shows);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    router.get('/api/shows/:code', async (req, res) => {
      try {
        const feedUrl = `https://wfmu.org/archivefeed/mp3/${req.params.code}.xml`;
        const episodes = await this.fetchFeed(feedUrl);
        res.json(episodes);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    router.get('/api/recent', async (req, res) => {
      try {
        const episodes = await this.fetchFeed(WFMU_RSS);
        res.json(episodes);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    router.post('/api/play', async (req, res) => {
      try {
        const { speaker, url, title } = req.body;
        if (!speaker || !url) {
          return res.status(400).json({ error: 'speaker and url are required' });
        }
        const device = await this.getSpeaker(speaker);
        const resolvedUrl = await this.resolveM3u(url);
        await device.setAVTransportURI({ uri: resolvedUrl, metadata: '' });
        await device.play();
        console.log(`[wfmu] Playing "${title || url}" on ${speaker}`);
        res.json({ success: true, speaker, url: resolvedUrl, title });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    router.post('/api/queue', async (req, res) => {
      try {
        const { speaker, episodes } = req.body;
        if (!speaker || !episodes?.length) {
          return res.status(400).json({ error: 'speaker and episodes array are required' });
        }
        const device = await this.getSpeaker(speaker);

        const resolved = [];
        for (const ep of episodes) {
          const url = await this.resolveM3u(ep.link);
          resolved.push({ ...ep, resolvedUrl: url });
        }

        await device.setAVTransportURI({ uri: resolved[0].resolvedUrl, metadata: '' });
        await device.play();
        for (let i = 1; i < resolved.length; i++) {
          await device.queue(resolved[i].resolvedUrl);
        }

        console.log(`[wfmu] Queued ${resolved.length} episodes on ${speaker}`);
        res.json({ success: true, speaker, queued: resolved.length });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    router.post('/api/live', async (req, res) => {
      try {
        const { speaker, stream } = req.body;
        if (!speaker) {
          return res.status(400).json({ error: 'speaker is required' });
        }
        const streamName = (stream || 'freeform').toLowerCase();
        const streamUrl = LIVE_STREAMS[streamName];
        if (!streamUrl) {
          return res.status(400).json({
            error: `Unknown stream "${stream}". Available: ${Object.keys(LIVE_STREAMS).join(', ')}`
          });
        }
        const device = await this.getSpeaker(speaker);
        await device.setAVTransportURI({ uri: streamUrl, metadata: '' });
        await device.play();
        console.log(`[wfmu] Playing live stream "${streamName}" on ${speaker}`);
        res.json({ success: true, speaker, stream: streamName, url: streamUrl });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    router.get('/api/now-playing', async (req, res) => {
      try {
        const speakerName = req.query.speaker;
        let device;
        if (speakerName) {
          device = await this.getSpeaker(speakerName);
        } else {
          const speakers = await this.discoverSpeakers();
          if (!speakers.length) {
            return res.json({ error: 'No speakers found' });
          }
          const sonos = await this.getSonosModule();
          device = new sonos.Sonos(speakers[0].ip);
        }
        const track = await device.currentTrack();
        res.json({
          title: track.title || null,
          artist: track.artist || null,
          album: track.album || null,
          uri: track.uri || null,
          duration: track.duration || null,
          position: track.position || null
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    router.post('/api/playback', async (req, res) => {
      try {
        const { speaker, action } = req.body;
        if (!speaker || !action) {
          return res.status(400).json({ error: 'speaker and action are required' });
        }
        const device = await this.getSpeaker(speaker);
        switch (action.toLowerCase()) {
          case 'play':     await device.play(); break;
          case 'pause':    await device.pause(); break;
          case 'stop':     await device.stop(); break;
          case 'next':     await device.next(); break;
          case 'previous': await device.previous(); break;
          default:
            return res.status(400).json({ error: `Unknown action "${action}". Use: play, pause, stop, next, previous` });
        }
        res.json({ success: true, speaker, action });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    router.post('/api/volume', async (req, res) => {
      try {
        const { speaker, volume } = req.body;
        if (!speaker || volume === undefined) {
          return res.status(400).json({ error: 'speaker and volume are required' });
        }
        const vol = Math.max(0, Math.min(100, parseInt(volume)));
        const device = await this.getSpeaker(speaker);
        await device.setVolume(vol);
        res.json({ success: true, speaker, volume: vol });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  async cleanup() {
    this.speakerCache = null;
    this.showCodeCache = null;
  }
}
