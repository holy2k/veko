import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import qrcode from 'qrcode-terminal';
import { loadConfig } from '../src/config.js';
import { createWhatsAppClient } from '../src/whatsapp/client.js';

export const AUDIO_CALL_SELECTORS = [
  '[data-icon="audio-call"]',
  '[data-icon="voice-call"]',
  '[aria-label*="Sesli arama" i]',
  '[aria-label*="Audio call" i]',
  '[aria-label*="Voice call" i]',
];

export const INCOMING_ACCEPT_SELECTORS = [
  '[role="toolbar"] button[aria-label*="Kabul et" i]',
  '[role="toolbar"] button[aria-label*="Accept" i]',
  '[role="toolbar"] button[aria-label*="Answer" i]',
  'button[aria-label="Kabul et" i]',
  'button[aria-label="Accept" i]',
  'button[aria-label="Answer" i]',
  '[data-testid*="accept-call" i]',
  '[data-testid*="answer-call" i]',
  '[data-icon*="call-accept" i]',
  '[data-icon*="accept-call" i]',
];

export const HANGUP_SELECTORS = [
  '[data-icon="call-end"]',
  '[data-icon*="call-end" i]',
  '[data-icon*="end-call" i]',
  '[data-icon*="hangup" i]',
  '[aria-label*="Aramayı sonlandır" i]',
  '[aria-label*="Aramayı bitir" i]',
  '[aria-label*="Aramayı kapat" i]',
  '[aria-label*="Aramadan ayrıl" i]',
  '[aria-label*="Çağrıyı sonlandır" i]',
  '[aria-label*="Sonlandır" i]',
  '[aria-label*="End call" i]',
  '[aria-label*="Leave call" i]',
  '[aria-label*="Hang up" i]',
  '[data-testid*="end-call" i]',
  '[data-testid*="hangup" i]',
];

/**
 * Generates mono 16-bit PCM samples for a sine test tone.
 *
 * @param {number} [freqHz=440]
 * @param {number} [durationSec=1]
 * @param {number} [sampleRate=24000]
 * @param {number} [amplitude=0.25]
 * @returns {number[]}
 */
export function generateSinePcm16(
  freqHz = 440,
  durationSec = 1,
  sampleRate = 24000,
  amplitude = 0.25
) {
  const totalSamples = Math.max(1, Math.round(durationSec * sampleRate));
  const out = new Array(totalSamples);
  const scale = Math.round(32767 * amplitude);
  const step = (2 * Math.PI * freqHz) / sampleRate;
  for (let i = 0; i < totalSamples; i++) {
    out[i] = Math.round(Math.sin(i * step) * scale);
  }
  return out;
}

async function openChatInPage(page, ownerPhone, ownerChatId) {
  console.log(`[spike] openChatInPage: trying WAWebCmd for ${ownerChatId}...`);
  const evaluatePromise = page.evaluate(async (chatId) => {
    try {
      const chat = await window.WWebJS?.getChat?.(chatId, { getAsModel: false });
      const Cmd = window.require?.('WAWebCmd')?.Cmd;
      if (chat && Cmd && typeof Cmd.openChatBottom === 'function') {
        await Cmd.openChatBottom({ chat });
        return { opened: true, method: 'openChatBottom' };
      }
      if (chat && Cmd && typeof Cmd.openChatAt === 'function') {
        await Cmd.openChatAt(chat);
        return { opened: true, method: 'openChatAt' };
      }
      return { opened: false, reason: chat ? 'no_cmd' : 'no_chat' };
    } catch (err) {
      return { opened: false, reason: String(err?.message || err) };
    }
  }, ownerChatId);

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve({ opened: false, reason: 'evaluate_timeout_3s' }), 3000)
  );
  const cmdResult = await Promise.race([evaluatePromise, timeoutPromise]);
  console.log('[spike] openChatInPage WAWebCmd result:', cmdResult);

  if (cmdResult?.opened) {
    await new Promise((r) => setTimeout(r, 1000));
    return;
  }

  console.log('[spike] WAWebCmd chat open unavailable; navigating via send URL...');
  await page.goto(`https://web.whatsapp.com/send?phone=${ownerPhone}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForSelector('footer, [data-testid="conversation-panel-wrapper"]', { timeout: 45000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
}

export function selectClickableCandidate(selectors, rootDoc, shouldClick = false) {
  const doc = rootDoc || (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;

  const visibleMatches = [];
  for (const sel of selectors) {
    const nodes = doc.querySelectorAll
      ? Array.from(doc.querySelectorAll(sel))
      : (doc.querySelector ? [doc.querySelector(sel)].filter(Boolean) : []);
    for (const el of nodes) {
      const clickable = el.closest?.('button, [role="button"]') || el;
      if (clickable.closest?.('#pane-side')) continue;
      const rect = typeof clickable.getBoundingClientRect === 'function'
        ? clickable.getBoundingClientRect()
        : { width: 1, height: 1 };
      if (rect.width > 0 && rect.height > 0) {
        const inHeader = Boolean(
          clickable.closest?.('#main header') || clickable.closest?.('header')
        );
        visibleMatches.push({ el, clickable, matchedSelector: sel, inHeader });
      }
    }
  }

  if (!visibleMatches.length) return null;
  const chosen = visibleMatches.find((m) => m.inHeader) || visibleMatches[0];
  if (shouldClick && typeof chosen.clickable.click === 'function') {
    chosen.clickable.click();
  }
  return {
    matchedSelector: chosen.matchedSelector,
    ariaLabel:
      chosen.clickable.getAttribute?.('aria-label') ||
      chosen.el.getAttribute?.('aria-label') ||
      '',
    tag: chosen.clickable.tagName || '',
    inHeader: chosen.inHeader,
  };
}

export function analyzeCallDomFromDocument(hangupSels, rootDoc) {
  const doc = rootDoc || (typeof document !== 'undefined' ? document : null);
  if (!doc) {
    return { hangupPresent: false, timerText: null, statusHints: [], hasCallContainer: false };
  }

  const isVisible = (el) => {
    if (!el) return false;
    if (typeof el.getBoundingClientRect !== 'function') return true;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const wrapsMainOrSidebar = (el) => {
    if (!el) return true;
    if (el.id === 'main' || el.id === 'pane-side' || el.id === 'app') return true;
    if (el.matches?.('body, html, #main, #pane-side, #app, [data-testid="conversation-panel-wrapper"]')) {
      return true;
    }
    if (el.querySelector?.('#main, #pane-side, [data-testid="conversation-panel-wrapper"]')) {
      return true;
    }
    return false;
  };

  let visibleHangup = null;
  for (const sel of hangupSels || []) {
    const nodes = doc.querySelectorAll
      ? Array.from(doc.querySelectorAll(sel))
      : (doc.querySelector ? [doc.querySelector(sel)].filter(Boolean) : []);
    for (const el of nodes) {
      const clickable = el.closest?.('button, [role="button"]') || el;
      if (isVisible(clickable)) {
        visibleHangup = clickable;
        break;
      }
    }
    if (visibleHangup) break;
  }

  const hangupPresent = Boolean(visibleHangup);
  const isInteractiveButton = (el) => {
    if (!el) return false;
    if (el === visibleHangup) return true;
    if (String(el.tagName || '').toUpperCase() === 'BUTTON') return true;
    if (el.getAttribute?.('role') === 'button') return true;
    if (el.matches?.('button, [role="button"]')) return true;
    return false;
  };

  const isUiControlWrapper = (el) => {
    if (!el) return false;
    const role = String(el.getAttribute?.('role') || '').toLowerCase();
    return role === 'toolbar' || role === 'group';
  };

  let callContainer = null;
  let foundExplicitVoipOrDialog = false;

  if (visibleHangup) {
    let searchStart = visibleHangup.parentElement;
    while (searchStart && isInteractiveButton(searchStart)) {
      searchStart = searchStart.parentElement;
    }

    let voipContainer = null;
    let dialogOverlay = null;
    let semanticOverlay = null;
    let fallbackBest = null;

    let cur = searchStart;
    let steps = 0;
    while (cur && !wrapsMainOrSidebar(cur)) {
      if (!isInteractiveButton(cur) && !isUiControlWrapper(cur)) {
        const textTrim = String(cur.innerText ?? cur.textContent ?? '').trim();
        if (!voipContainer && cur.matches?.('[data-testid*="voip-container" i]')) {
          voipContainer = cur;
        }
        if (!dialogOverlay && cur.matches?.('[role="dialog"]')) {
          dialogOverlay = cur;
        }
        if (
          textTrim &&
          cur.matches?.('[data-testid*="call" i], [aria-label*="call" i], [aria-label*="arama" i]')
        ) {
          semanticOverlay = cur;
        }
        if (steps < 12 && textTrim) {
          fallbackBest = cur;
        }
      }
      cur = cur.parentElement;
      steps += 1;
    }

    foundExplicitVoipOrDialog = Boolean(voipContainer || dialogOverlay);
    callContainer = voipContainer || dialogOverlay || semanticOverlay || fallbackBest;
  }

  // If hangup's parent walk didn't find an explicit voip/dialog container (or found an empty wrapper),
  // look for a visible sibling floating call card / voip-container outside #main and #pane-side.
  const currentContainerText = callContainer
    ? String(callContainer.innerText ?? callContainer.textContent ?? '').trim()
    : '';
  if ((!callContainer || (!foundExplicitVoipOrDialog && !currentContainerText) || !foundExplicitVoipOrDialog) && doc.querySelectorAll) {
    const overlayCandidates = Array.from(
      doc.querySelectorAll('[data-testid*="voip-container" i], [role="dialog"], [data-testid*="call" i]')
    ).filter(
      (el) =>
        isVisible(el) &&
        !isInteractiveButton(el) &&
        !isUiControlWrapper(el) &&
        !wrapsMainOrSidebar(el) &&
        !el.closest?.('#main, #pane-side')
    );
    const voipMatch = overlayCandidates.find((el) => el.matches?.('[data-testid*="voip-container" i]'));
    const dialogMatch = overlayCandidates.find((el) => el.matches?.('[role="dialog"]'));
    const nonEmptyMatch = overlayCandidates.find((el) => Boolean(String(el.innerText ?? el.textContent ?? '').trim()));
    const siblingContainer = voipMatch || dialogMatch || nonEmptyMatch || overlayCandidates[0] || null;
    if (voipMatch || dialogMatch || !callContainer) {
      callContainer = siblingContainer || callContainer;
    } else if (!currentContainerText && siblingContainer) {
      callContainer = siblingContainer;
    }
  }

  if (!callContainer) {
    return {
      hangupPresent,
      timerText: null,
      statusHints: [],
      hasCallContainer: false,
    };
  }

  const containerText = String(callContainer.innerText ?? callContainer.textContent ?? '');
  const lines = containerText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const timerEl =
    callContainer.querySelector?.('[data-testid="voip-call-timer"], [role="timer"]') ||
    (hangupPresent && doc.querySelector
      ? Array.from(doc.querySelectorAll?.('[data-testid="voip-call-timer"], [role="timer"]') || []).find(
          (el) => isVisible(el) && !el.closest?.('#main, #pane-side')
        )
      : null);
  const timerNodeText = String(timerEl?.innerText ?? timerEl?.textContent ?? '').trim();
  const timerText =
    (/^\d{1,2}:\d{2}$/.test(timerNodeText) ? timerNodeText : null) ||
    lines.find((line) => /^(?:0?\d):\d{2}$/.test(line)) ||
    null;

  const keywords = [
    'Aranıyor',
    'Çalıyor',
    'Ringing',
    'Calling',
    'Reddedildi',
    'Declined',
    'Cevap yok',
    'No answer',
    'Meşgul',
    'Busy',
    'Bağlanıyor',
    'Connecting',
    'Arama bitti',
    'Call ended',
  ];
  const lower = containerText.toLowerCase();
  const statusHints = [];
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) {
      statusHints.push(kw);
    }
  }

  return {
    hangupPresent,
    timerText,
    statusHints,
    hasCallContainer: true,
  };
}

export function createSpikeLifecycle({ onReadyOnce, onAbort }) {
  let readyHandled = false;
  let aborted = false;

  async function triggerAbort(reason, code = 1) {
    if (aborted) return;
    aborted = true;
    await onAbort(reason, code);
  }

  return {
    async onReady() {
      if (readyHandled || aborted) {
        return;
      }
      readyHandled = true;
      await onReadyOnce();
    },
    async onAuthFailure(message) {
      await triggerAbort(`auth_failure: ${message || 'unknown'}`, 1);
    },
    async onDisconnected(reason) {
      if (!readyHandled) {
        await triggerAbort(`disconnected before ready: ${reason || 'unknown'}`, 1);
      }
    },
  };
}

async function clickFirstMatchingButton(page, selectors) {
  return page.evaluate(selectClickableCandidate, selectors, undefined, true);
}

async function inspectCallDomState(page, hangupSelectors) {
  return page.evaluate(analyzeCallDomFromDocument, hangupSelectors);
}

async function runSpike() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    console.error(`[spike] Configuration error: ${err.message}`);
    console.error('[spike] Set OWNER_PHONE and GEMINI_API_KEY in .env before running npm run spike.');
    process.exitCode = 1;
    return;
  }

  console.log('[spike] Booting WhatsApp Web client...', {
    headless: config.chromeHeadless,
    ownerChatId: config.ownerChatId,
    ringTimeoutSec: config.callRingTimeoutSec,
  });

  let whatsapp = null;
  const lifecycle = createSpikeLifecycle({
    async onAbort(reason, code = 1) {
      console.error('[spike] Terminating:', reason);
      await whatsapp?.destroy().catch(() => {});
      process.exit(code);
    },
    async onReadyOnce() {
      try {
        console.log('[spike] WhatsApp Web READY. Opening owner chat...');
        const page = whatsapp.getPage();
        if (!page) {
          throw new Error('pupPage is not available');
        }

        const hookPresent = await page.evaluate(() => Boolean(window.__wpJarvisAudio));
        console.log('[spike] window.__wpJarvisAudio injected:', hookPresent);
        if (!hookPresent) {
          throw new Error('window.__wpJarvisAudio was not injected via evaluateOnNewDocument');
        }

        await openChatInPage(page, config.ownerPhone, config.ownerChatId);

        const chatHeaderInfo = await page.evaluate(() => {
          const header = document.querySelector('#main header');
          const buttons = Array.from(document.querySelectorAll('#main header button, #main header [role="button"], [role="dialog"] button')).map((b) => ({
            tag: b.tagName,
            ariaLabel: b.getAttribute('aria-label') || '',
            title: b.getAttribute('title') || '',
            text: (b.innerText || '').trim().slice(0, 60),
          }));
          return {
            headerText: (header?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
            buttons,
          };
        });
        console.log('[spike] Opened chat header:', JSON.stringify(chatHeaderInfo));

        fs.mkdirSync(path.resolve('data'), { recursive: true });
        await page.screenshot({ path: path.resolve('data/spike-before-click.png') }).catch(() => {});

        console.log('[spike] Searching for audio call button...');
        const clicked = await clickFirstMatchingButton(page, AUDIO_CALL_SELECTORS);
        if (!clicked) {
          console.error('[spike] Could not find audio call button. Tried selectors:', AUDIO_CALL_SELECTORS);
          await whatsapp.destroy();
          process.exit(1);
          return;
        }
        console.log('[spike] Clicked audio call button:', clicked);

        const startedAt = Date.now();
        const timeoutMs = (config.callRingTimeoutSec || 35) * 1000;
        let seenEventCount = 0;
        let connected = false;
        let endedEarly = false;
        let sawHangupOnce = false;
        let capturedAfterClickScreenshot = false;
        let capturedMidScreenshot = false;
        let lastDomLog = '';

        const dumpFloatingCallDiag = async (tag) => {
          const ui = await page
            .evaluate(() => {
              const outsideBtns = Array.from(document.querySelectorAll('button, [role="button"]'))
                .filter((b) => {
                  if (b.closest('#main, #pane-side')) return false;
                  const r = b.getBoundingClientRect();
                  return r.width > 0 && r.height > 0;
                })
                .map((b) => {
                  const icons = Array.from(b.querySelectorAll('[data-icon], svg')).map((el) => ({
                    dataIcon: el.getAttribute?.('data-icon') || null,
                    ariaLabel: el.getAttribute?.('aria-label') || null,
                  }));
                  const bg = window.getComputedStyle?.(b)?.backgroundColor || '';
                  const r = b.getBoundingClientRect();
                  return {
                    tag: b.tagName,
                    ariaLabel: b.getAttribute('aria-label') || '',
                    title: b.getAttribute('title') || '',
                    dataTestId: b.getAttribute('data-testid') || '',
                    text: (b.innerText || '').trim().slice(0, 40),
                    bg,
                    icons: icons.filter((i) => i.dataIcon || i.ariaLabel),
                    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
                  };
                });

              const overlays = Array.from(
                document.querySelectorAll('[role="dialog"], [data-testid*="call" i], [aria-label*="arama" i], [aria-label*="call" i]')
              )
                .filter((el) => {
                  if (el.closest('#main, #pane-side')) return false;
                  const r = el.getBoundingClientRect();
                  return r.width > 0 && r.height > 0;
                })
                .map((el) => ({
                  tag: el.tagName,
                  role: el.getAttribute('role') || '',
                  dataTestId: el.getAttribute('data-testid') || '',
                  ariaLabel: el.getAttribute('aria-label') || '',
                  text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140),
                }))
                .slice(0, 12);

              return { outsideBtns, overlays };
            })
            .catch((err) => ({ error: String(err?.message || err) }));
          console.log(`[spike][diag@${tag}]`, JSON.stringify(ui));
        };

        const flushWebrtcEvents = (telemetry) => {
          if (telemetry.events.length <= seenEventCount) return;
          for (const evt of telemetry.events.slice(seenEventCount)) {
            if (
              evt.type === 'getUserMedia' ||
              evt.type === 'pc_created' ||
              evt.type === 'track' ||
              evt.type === 'connectionstatechange' ||
              evt.type === 'audio_capture_attached'
            ) {
              console.log('[spike][webrtc]', JSON.stringify(evt));
            }
          }
          seenEventCount = telemetry.events.length;
        };

        while (Date.now() - startedAt < timeoutMs) {
          await new Promise((r) => setTimeout(r, 500));

          const telemetry = await page.evaluate(() => window.__wpJarvisAudio.getTelemetry());
          const domState = await inspectCallDomState(page, HANGUP_SELECTORS);

          if (!capturedAfterClickScreenshot && Date.now() - startedAt >= 1500) {
            capturedAfterClickScreenshot = true;
            await page.screenshot({ path: path.resolve('data/spike-after-click.png') }).catch(() => {});
            await dumpFloatingCallDiag('1.5s');
          }

          if (!capturedMidScreenshot && Date.now() - startedAt >= 6000) {
            capturedMidScreenshot = true;
            await page.screenshot({ path: path.resolve('data/spike-during-wait.png') }).catch(() => {});
            await dumpFloatingCallDiag('6.0s');
          }

          flushWebrtcEvents(telemetry);

          const domLogKey = JSON.stringify({
            hangupPresent: domState.hangupPresent,
            timerText: domState.timerText,
            statusHints: domState.statusHints,
            hasCallContainer: domState.hasCallContainer,
            pcCount: telemetry.peerConnections?.length || 0,
            remoteAudioTracks: (telemetry.peerConnections || []).reduce(
              (acc, p) => acc + (p.remoteAudioTracks || 0),
              0
            ),
          });
          if (domLogKey !== lastDomLog) {
            lastDomLog = domLogKey;
            console.log(`[spike][dom@${((Date.now() - startedAt) / 1000).toFixed(1)}s]`, domLogKey);
          }

          if (domState.hangupPresent) {
            sawHangupOnce = true;
          }

          // Do not treat early-media/loopback WebRTC connection during "Aranıyor" as answered;
          // wait for the live call timer (`00:xx`) in the active call UI (or remote track after ringing).
          const isTimerRunning = Boolean(domState.timerText);
          if (isTimerRunning) {
            connected = true;
            await page.screenshot({ path: path.resolve('data/spike-connected.png') }).catch(() => {});
            console.log('[spike] Call CONNECTED!', {
              iceConnectionState: telemetry.latestIceConnectionState,
              connectionState: telemetry.latestConnectionState,
              timerText: domState.timerText,
              statusHints: domState.statusHints,
              hasCallContainer: domState.hasCallContainer,
              peerConnections: telemetry.peerConnections,
            });
            break;
          }

          const rejectedHint = domState.statusHints.some((h) =>
            ['Reddedildi', 'Declined', 'Meşgul', 'Busy', 'Arama bitti', 'Call ended'].includes(h)
          );
          if (rejectedHint || (sawHangupOnce && !domState.hangupPresent && Date.now() - startedAt > 2000)) {
            endedEarly = true;
            await page.screenshot({ path: path.resolve('data/spike-ended-early.png') }).catch(() => {});
            console.log('[spike] Call REJECTED / ended early while ringing:', domState);
            break;
          }
        }

        if (connected) {
          console.log('[spike] Starting 10s two-way audio verification (440Hz tone out, 16kHz PCM in)...');
          await page.evaluate(() => window.__wpJarvisAudio.startIncomingCapture());
          const toneChunk = generateSinePcm16(440, 0.85, 24000, 0.28);

          for (let sec = 0; sec < 10; sec++) {
            await page.evaluate((samples) => {
              window.__wpJarvisAudio.pushOutgoingPcm(samples, 24000);
            }, toneChunk);
            const tNow = await page.evaluate(() => window.__wpJarvisAudio.getTelemetry());
            flushWebrtcEvents(tNow);
            await new Promise((r) => setTimeout(r, 1000));
          }

          const audioStats = await page.evaluate(() => {
            window.__wpJarvisAudio.stopIncomingCapture();
            const pcm = window.__wpJarvisAudio.drainIncomingPcm();
            let drainedMaxPeak = 0;
            let sumSq = 0;
            for (let i = 0; i < pcm.length; i++) {
              const abs = Math.abs(pcm[i]);
              if (abs > drainedMaxPeak) drainedMaxPeak = abs;
              sumSq += pcm[i] * pcm[i];
            }
            const drainedRms = pcm.length ? Math.round(Math.sqrt(sumSq / pcm.length)) : 0;
            const telemetry = window.__wpJarvisAudio.getTelemetry();
            const inCtxStates = (window.__wpJarvisAudio._debugGetIncomingContexts?.() || []).map((c) => c.state);
            return {
              drainedSamples: pcm.length,
              drainedBytes: pcm.byteLength,
              drainedMaxPeak,
              drainedRms,
              incomingChunksCaptured: telemetry.incomingChunksCaptured,
              incomingBytesCaptured: telemetry.incomingBytesCaptured,
              lastIncomingPeak: telemetry.lastIncomingPeak,
              lastIncomingRms: telemetry.lastIncomingRms,
              outgoingQueueCount: telemetry.outgoingQueueCount,
              outgoingSampleRate: telemetry.outgoingSampleRate,
              incomingSampleRate: telemetry.incomingSampleRate,
              inCtxStates,
              peerConnections: telemetry.peerConnections,
            };
          });
          console.log('[spike] Audio capture summary:', JSON.stringify(audioStats));

          const hungUp = await clickFirstMatchingButton(page, HANGUP_SELECTORS);
          console.log('[spike] Clicked hangup button:', hungUp);
        } else if (!endedEarly) {
          console.log('[spike] Ring timeout reached (MISSED). Inspecting DOM and hanging up...');
          await page.screenshot({ path: path.resolve('data/spike-timeout.png') }).catch(() => {});
          await dumpFloatingCallDiag('timeout');
          const domState = await inspectCallDomState(page, HANGUP_SELECTORS);
          const tEnd = await page.evaluate(() => window.__wpJarvisAudio.getTelemetry());
          console.log('[spike] Timeout DOM state:', domState);
          console.log('[spike] Timeout PCs:', JSON.stringify(tEnd.peerConnections));
          const hungUp = await clickFirstMatchingButton(page, HANGUP_SELECTORS);
          console.log('[spike] Timeout hangup click:', hungUp);
        }

        await new Promise((r) => setTimeout(r, 1000));
        await whatsapp.destroy();
        process.exit(0);
      } catch (err) {
        console.error('[spike] Error during spike:', err);
        await whatsapp.destroy().catch(() => {});
        process.exit(1);
      }
    },
  });

  whatsapp = createWhatsAppClient(config, {
    onQr(qr) {
      console.log('\n[spike] Scan QR code with WhatsApp Business on your phone:\n');
      qrcode.generate(qr, { small: true });
    },
    onAuthFailure(message) {
      return lifecycle.onAuthFailure(message);
    },
    onDisconnected(reason) {
      console.log('[spike] Disconnected:', reason);
      return lifecycle.onDisconnected(reason);
    },
    onReady: () => lifecycle.onReady(),
  });

  await whatsapp.initialize().catch(async (err) => {
    console.error('[spike] Initialization failed:', err);
    await whatsapp?.destroy().catch(() => {});
    process.exit(1);
  });
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runSpike();
}
