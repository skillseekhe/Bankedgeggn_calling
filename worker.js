// BankEdge AI - live voice call agent
// Exotel Voicebot applet (WebSocket audio)  <->  this Cloudflare Worker  <->  Gemini Live API (speech to speech)
//
// Secrets to set in Cloudflare (Settings > Variables and Secrets):
//   GEMINI_API_KEY  - from aistudio.google.com
//   WS_TOKEN        - any long random text; also put it in the Exotel URL (?token=...)
//   ADMIN_KEY       - any long random password, used to view leads
// Optional KV binding named CALLS stores leads (see wrangler.toml).

// ====== EDIT THIS SECTION WITH YOUR REAL DETAILS ======
const BUSINESS = `
Name: BankEdge, a banking training center.
Address: Spanish Court, near Krishna Chowk, Gurugram.
Timings: Monday to Saturday, 9 AM to 7 PM

Courses:
- Probe - 40000, 2.5 Months
- PCPBF - 67500, 4-6 Months
Other info:
- Counselling: Free Counselling Available
- Payment options: Online
`;
// ======================================================

const MODEL = "gemini-3.1-flash-live-preview";
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const CHUNK = 3200; // 100 ms of 8 kHz 16-bit mono audio (Exotel's minimum chunk; must be a multiple of 320)
const EMPTY = new Uint8Array(0);

const SYSTEM_PROMPT = `You are the phone receptionist for BankEdge, a banking training center in Gurugram. You are on a live phone call.
- Speak in the language the caller uses (Hindi, English or Hinglish). Default to simple, warm Hinglish.
- Keep every reply to one or two short sentences, like a real receptionist. Never read out lists.
- Use ONLY the business information below. If something is not listed (a fee, a date, anything), do not guess: say the team will confirm and offer a callback.
- Goal: answer questions, then get the caller's name and the course they want, and invite them to visit or attend a demo.
- As soon as you know the caller's name or course interest, call save_lead. Do not mention that you are doing this.
- If the caller wants to speak to a person, say the team will call back shortly, ask for a good time, and call save_lead with callback_time.
- If asked, say you are BankEdge's AI assistant.
- Never ask for card numbers, OTPs, Aadhaar or any ID details.
- When the conversation is finished, say a short goodbye, then call end_call.

BUSINESS INFORMATION:
${BUSINESS}`;

const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "save_lead",
        description: "Save the caller's details for the BankEdge team. Call whenever you learn the name, interest or callback time.",
        parameters: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING", description: "Caller's name" },
            interest: { type: "STRING", description: "Course or topic they are interested in" },
            callback_time: { type: "STRING", description: "When they want a callback, if requested" },
          },
        },
      },
      {
        name: "end_call",
        description: "Hang up the call. Use only after saying goodbye.",
        parameters: {
          type: "OBJECT",
          properties: { reason: { type: "STRING", description: "Why the call is ending" } },
        },
      },
    ],
  },
];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Exotel Voicebot applet connects here: wss://YOUR-WORKER/ws?token=WS_TOKEN
    if (url.pathname === "/ws" && req.headers.get("Upgrade") === "websocket") {
      if (env.WS_TOKEN && url.searchParams.get("token") !== env.WS_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      runCall(server, env);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/leads") {
      if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (!env.CALLS) return new Response("KV not bound; leads are only in the Worker logs.");
      const list = await env.CALLS.list({ prefix: "lead:" });
      const rows = [];
      for (const k of list.keys.reverse()) rows.push(await env.CALLS.get(k.name));
      return new Response(rows.join("\n\n") || "No leads yet.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("BankEdge AI calling is live.");
  },
};

function runCall(exo, env) {
  const call = {
    streamSid: "",
    callSid: "",
    from: "",
    started: false,
    ready: false,
    greeted: false,
    end: false,
    closed: false,
    gem: null,
    out: EMPTY, // 8 kHz audio waiting to be sent to the caller
    carry: EMPTY, // leftover 24 kHz bytes from Gemini
    lead: {},
  };

  const sendExo = (obj) => {
    try {
      exo.send(JSON.stringify(obj));
    } catch (_) {}
  };
  const sendGem = (obj) => {
    try {
      if (call.gem) call.gem.send(JSON.stringify(obj));
    } catch (_) {}
  };

  function closeAll() {
    if (call.closed) return;
    call.closed = true;
    try {
      if (call.gem) call.gem.close(1000, "done");
    } catch (_) {}
    try {
      exo.close(1000, "done");
    } catch (_) {}
  }

  function maybeGreet() {
    if (call.ready && call.started && !call.greeted) {
      call.greeted = true;
      sendGem({ realtimeInput: { text: "The call has just connected. Greet the caller now." } });
    }
  }

  function sendAudioToCaller(bytes) {
    sendExo({ event: "media", stream_sid: call.streamSid, media: { payload: bytesToB64(bytes) } });
  }

  function pushAudio(bytes24k) {
    const buf = concat(call.carry, bytes24k);
    const usable = buf.length - (buf.length % 6); // 3 samples of 2 bytes -> 1 sample at 8 kHz
    call.carry = buf.slice(usable);
    if (usable === 0) return;
    const pcm8 = downsample24to8(buf.subarray(0, usable));
    call.out = concat(call.out, pcm8);
    while (call.out.length >= CHUNK) {
      sendAudioToCaller(call.out.slice(0, CHUNK));
      call.out = call.out.slice(CHUNK);
    }
  }

  function flushAudio() {
    if (call.out.length > 0) {
      const padded = new Uint8Array(CHUNK * Math.ceil(call.out.length / CHUNK));
      padded.set(call.out);
      call.out = EMPTY;
      for (let i = 0; i < padded.length; i += CHUNK) sendAudioToCaller(padded.slice(i, i + CHUNK));
    }
  }

  function handleTools(tc) {
    const responses = [];
    for (const fc of tc.functionCalls || []) {
      if (fc.name === "save_lead") {
        Object.assign(call.lead, Object.fromEntries(Object.entries(fc.args || {}).filter(([, v]) => v)));
        persistLead(env, call);
      } else if (fc.name === "end_call") {
        call.end = true;
      }
      responses.push({ id: fc.id, name: fc.name, response: { ok: true } });
    }
    sendGem({ toolResponse: { functionResponses: responses } });
  }

  function onGemini(e) {
    let data = e.data;
    if (typeof data !== "string") data = new TextDecoder().decode(data);
    let m;
    try {
      m = JSON.parse(data);
    } catch (_) {
      return;
    }
    if (m.setupComplete) {
      call.ready = true;
      maybeGreet();
      return;
    }
    if (m.toolCall) {
      handleTools(m.toolCall);
      return;
    }
    const sc = m.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      // Caller started talking: stop whatever the bot was saying
      call.out = EMPTY;
      call.carry = EMPTY;
      sendExo({ event: "clear", stream_sid: call.streamSid });
    }
    const parts = sc.modelTurn && sc.modelTurn.parts;
    if (parts) {
      for (const p of parts) {
        if (p.inlineData && p.inlineData.data) pushAudio(b64ToBytes(p.inlineData.data));
      }
    }
    if (sc.turnComplete) {
      flushAudio();
      if (call.end) {
        // Exotel echoes this mark when the goodbye has finished playing; hang up then (or after 6 s at most)
        sendExo({ event: "mark", stream_sid: call.streamSid, mark: { name: "end" } });
        setTimeout(closeAll, 6000);
      }
    }
  }

  async function connectGemini() {
    try {
      const resp = await fetch(`${GEMINI_URL}?key=${env.GEMINI_API_KEY}`, { headers: { Upgrade: "websocket" } });
      const gem = resp.webSocket;
      if (!gem) throw new Error(`Gemini WebSocket upgrade failed (HTTP ${resp.status})`);
      gem.accept();
      call.gem = gem;
      if (call.closed) return closeAll();
      gem.addEventListener("message", onGemini);
      gem.addEventListener("close", (ev) => {
        console.log("Gemini closed", ev.code, ev.reason);
        closeAll();
      });
      gem.addEventListener("error", () => closeAll());
      sendGem({
        setup: {
          model: `models/${MODEL}`,
          responseModalities: ["AUDIO"],
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          tools: TOOLS,
        },
      });
    } catch (err) {
      console.log("Gemini connect error:", err.message);
      closeAll();
    }
  }

  exo.addEventListener("message", (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch (_) {
      return;
    }
    switch (m.event) {
      case "start": {
        const s = m.start || m;
        call.streamSid = s.stream_sid || m.stream_sid || m.streamSid || call.streamSid;
        call.callSid = s.call_sid || "";
        call.from = s.from || "";
        call.started = true;
        maybeGreet();
        break;
      }
      case "media": {
        const payload = m.media && m.media.payload;
        if (!payload || !call.ready) break; // drop audio until Gemini is ready
        if (!call.streamSid) call.streamSid = m.stream_sid || "";
        const pcm16k = upsample8to16(b64ToBytes(payload));
        sendGem({ realtimeInput: { audio: { data: bytesToB64(pcm16k), mimeType: "audio/pcm;rate=16000" } } });
        break;
      }
      case "mark":
        if (call.end && m.mark && m.mark.name === "end") closeAll();
        break;
      case "stop":
        closeAll();
        break;
    }
  });
  exo.addEventListener("close", () => closeAll());
  exo.addEventListener("error", () => closeAll());

  connectGemini();
}

function persistLead(env, call) {
  const l = call.lead;
  const row =
    `Time: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}\n` +
    `Phone: ${call.from || "unknown"}\nName: ${l.name || "-"}\nInterested in: ${l.interest || "-"}\n` +
    `Callback: ${l.callback_time || "-"}`;
  console.log("LEAD", row);
  if (env.CALLS) {
    env.CALLS.put(`lead:${call.callSid || Date.now()}`, row, { expirationTtl: 60 * 60 * 24 * 90 }).catch(() => {});
  }
}

// ---- audio helpers (all PCM is 16-bit little-endian mono) ----
function toInt16(bytes) {
  const len = bytes.length - (bytes.length % 2);
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + len));
}
function upsample8to16(bytes) {
  const s = toInt16(bytes);
  const out = new Int16Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    out[2 * i] = s[i];
    out[2 * i + 1] = i + 1 < s.length ? (s[i] + s[i + 1]) >> 1 : s[i];
  }
  return new Uint8Array(out.buffer);
}
function downsample24to8(bytes) {
  const s = toInt16(bytes);
  const n = Math.floor(s.length / 3);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = ((s[3 * i] + s[3 * i + 1] + s[3 * i + 2]) / 3) | 0;
  return new Uint8Array(out.buffer);
}
function concat(a, b) {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
function bytesToB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
export class Store {
  constructor(state, env) {}
  async fetch() {
    return new Response("unused");
  }
}
