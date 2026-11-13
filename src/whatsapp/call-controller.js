import { getBrowserHookScript } from './injected-hook.js';
import { int16ToBase64 } from './pcm.js';
import { normalizePhone, toWhatsAppId } from '../utils/phone.js';
import {
  AUDIO_CALL_SELECTORS,
  INCOMING_ACCEPT_SELECTORS,
  HANGUP_SELECTORS,
  analyzeCallDomFromDocument,
  selectClickableCandidate,
} from '../../scripts/spike-webrtc-call.js';

const REJECTED_STATUS_HINTS = new Set(['Reddedildi', 'Declined', 'Meşgul', 'Busy']);
const NO_ANSWER_STATUS_HINTS = new Set(['Cevap yok', 'No answer']);
const ENDED_STATUS_HINTS = new Set(['Arama bitti', 'Call ended']);

// Puppeteer throws if exposeFunction is registered twice for the same binding name on a Page.
// We register once per Puppeteer Page instance and swap the active call handlers safely across calls.
const pageBridgeRegistry = new WeakMap();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toTimeoutMs(seconds, fallbackSec) {
  if (seconds === undefined || seconds === null || seconds === '') {
    return Math.max(10, fallbackSec * 1000);
  }
  const num = Number(seconds);
  const effectiveSec = Number.isFinite(num) && num > 0 ? num : fallbackSec;
  return Math.max(10, effectiveSec * 1000);
}

function isPcTerminal(pc, allowDisconnected = false) {
  return (
    pc.connectionState === 'failed' ||
    pc.connectionState === 'closed' ||
    pc.iceConnectionState === 'failed' ||
    pc.iceConnectionState === 'closed' ||
    (allowDisconnected && pc.iceConnectionState === 'disconnected')
  );
}

/**
 * Classifies the final outcome of a WhatsApp call lifecycle.
 *
 * @param {object} [flags={}]
 * @param {boolean} [flags.wasConnected=false]
 * @param {boolean} [flags.timedOut=false]
 * @param {boolean} [flags.endedEarlyWhileRinging=false]
 * @param {boolean} [flags.hasError=false]
 * @returns {'answered' | 'rejected' | 'missed' | 'error'}
 */
export function classifyCallOutcome({
  wasConnected = false,
  timedOut = false,
  endedEarlyWhileRinging = false,
  hasError = false,
} = {}) {
  if (hasError && !wasConnected) return 'error';
  if (wasConnected) return 'answered';
  if (endedEarlyWhileRinging) return 'rejected';
  if (timedOut) return 'missed';
  return 'error';
}

async function ensurePageBridge(page) {
  let entry = pageBridgeRegistry.get(page);
  if (entry) {
    return entry;
  }

  entry = { onAudio: null, onState: null };

  const registerBinding = async (name, fn) => {
    try {
      await page.exposeFunction(name, fn);
    } catch (err) {
      if (!/already exists/i.test(String(err?.message || err))) {
        throw err;
      }
      if (typeof page.removeExposedFunction === 'function') {
        await page.removeExposedFunction(name).catch(() => {});
        await page.exposeFunction(name, fn);
      }
    }
  };

  await registerBinding('__wpJarvisOnIncomingAudio', (b64, meta) => {
    entry.onAudio?.(b64, meta);
  });
  await registerBinding('__wpJarvisOnCallState', (evt) => {
    entry.onState?.(evt);
  });

  pageBridgeRegistry.set(page, entry);
  return entry;
}

async function verifyOrReinstateBridgeAfterNavigation(page, hookScript) {
  const status = await page
    .evaluate(() => ({
      hasHook: Boolean(window.__wpJarvisAudio),
      hasAudioBinding: typeof window.__wpJarvisOnIncomingAudio === 'function',
      hasStateBinding: typeof window.__wpJarvisOnCallState === 'function',
    }))
    .catch(() => null);

  if (status && status.hasHook === false) {
    await page
      .evaluate((src) => {
        if (!window.__wpJarvisAudio) {
          // eslint-disable-next-line no-eval
          (0, eval)(src);
        }
      }, hookScript)
      .catch(() => {});
  }

  if (status && (status.hasAudioBinding === false || status.hasStateBinding === false)) {
    pageBridgeRegistry.delete(page);
    return ensurePageBridge(page);
  }

  return ensurePageBridge(page);
}

async function openOwnerChat(page, ownerPhone, ownerChatId, chatOpenSettleMs) {
  const openedViaCmd = await page
    .evaluate(async (chatId) => {
      try {
        const chat = await window.WWebJS?.getChat?.(chatId, { getAsModel: false });
        const Cmd = window.require?.('WAWebCmd')?.Cmd;
        if (chat && Cmd && typeof Cmd.openChatBottom === 'function') {
          await Cmd.openChatBottom({ chat });
          return true;
        }
        if (chat && Cmd && typeof Cmd.openChatAt === 'function') {
          await Cmd.openChatAt(chat);
          return true;
        }
      } catch {
        // Fallback to URL navigation below
      }
      return false;
    }, ownerChatId)
    .catch(() => false);

  if (openedViaCmd) {
    if (chatOpenSettleMs > 0) await sleep(chatOpenSettleMs);
    return { navigated: false };
  }

  await page.goto(`https://web.whatsapp.com/send?phone=${ownerPhone}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page
    .waitForSelector?.('footer, [data-testid="conversation-panel-wrapper"]', { timeout: 45000 })
    .catch(() => {});
  if (chatOpenSettleMs > 0) await sleep(chatOpenSettleMs);
  return { navigated: true };
}

async function readWaCallState(page) {
  if (!page || typeof page.evaluate !== 'function') return null;
  return page
    .evaluate(() => {
      try {
        const col = window.require?.('WAWebCallCollection');
        if (!col || typeof col !== 'object') return null;
        return {
          hasActiveCall: Boolean(col.activeCall),
          isInConnectedCall: Boolean(col.isInConnectedCall),
        };
      } catch {
        return null;
      }
    })
    .catch(() => null);
}

async function ensureHookPresent(page, hookScript) {
  const hasHook = await page
    .evaluate(() => Boolean(window.__wpJarvisAudio))
    .catch(() => true);
  if (hasHook === false) {
    await page
      .evaluate((src) => {
        if (!window.__wpJarvisAudio) {
          // eslint-disable-next-line no-eval
          (0, eval)(src);
        }
      }, hookScript)
      .catch(() => {});
  }
}

async function clickButtonWithRetries(
  page,
  selectors,
  retryCount,
  retryDelayMs,
  shouldAbort
) {
  const attempts = Math.max(1, retryCount);
  for (let i = 0; i < attempts; i++) {
    if (shouldAbort?.()) return null;
    const clicked = await page
      .evaluate(selectClickableCandidate, selectors, null, true)
      .catch(() => null);
    if (clicked) {
      return clicked;
    }
    if (i + 1 < attempts && retryDelayMs > 0 && !shouldAbort?.()) {
      await sleep(retryDelayMs);
    }
  }
  return null;
}

/**
 * Creates a call lifecycle controller that places or answers WhatsApp Web audio calls to the owner,
 * bridges bidirectional PCM audio via Puppeteer CDP bindings (immune to WhatsApp CSP),
 * and accurately classifies answered, rejected, missed, and error outcomes.
 *
 * @param {object} params
 * @param {object} params.client - WhatsAppAdapter from createWhatsAppClient
 * @param {object} params.config - AppConfig
 * @param {number} [params.pollIntervalMs=350]
 * @param {number} [params.earlyCloseGraceMs=2000]
 * @param {number} [params.chatOpenSettleMs=500]
 * @param {number} [params.callButtonRetryCount=4]
 * @param {number} [params.callButtonRetryDelayMs=300]
 * @param {number} [params.bridgeBatchSamples=320]
 * @returns {{ startCallWithOwner: Function, answerIncomingCall: Function, isCallActive: Function }}
 */
export function createCallController({
  client,
  config = {},
  pollIntervalMs = 350,
  earlyCloseGraceMs = 2000,
  chatOpenSettleMs = 500,
  callButtonRetryCount = 4,
  callButtonRetryDelayMs = 300,
  bridgeBatchSamples = 320,
} = {}) {
  const hookScript = getBrowserHookScript();
  let activeCall = null;

  async function runCallSession({ mode = 'outgoing', onConnected, onAudioFromOwner, onEnded } = {}) {
    if (activeCall !== null) {
      throw new Error('A call is already in progress');
    }

    const isIncoming = mode === 'incoming';
    const page = client?.getPage?.() || client?.getClient?.()?.pupPage || null;
    const ownerPhone = normalizePhone(config.ownerPhone || config.ownerChatId || '');
    const ownerChatId = config.ownerChatId || toWhatsAppId(ownerPhone);

    let ended = false;
    let wasConnected = false;
    let timedOut = false;
    let endedEarlyWhileRinging = false;
    let hasError = false;
    let sawHangupOnce = false;
    let sawWaActiveCallOnce = false;
    let baselinePcCount = 0;
    const preExistingActivePcIds = new Set();
    const callPcIds = new Set();
    const callPcStates = new Map();

    const clickHangup = () =>
      page
        ? page.evaluate(selectClickableCandidate, HANGUP_SELECTORS, null, true).catch(() => null)
        : Promise.resolve(null);

    let ringTimer = null;
    let maxDurationTimer = null;
    let pollTimer = null;
    let pollingInFlight = false;
    let finalizePromise = null;
    let finalOutcome = null;
    let bridge = null;
    let onPageClose = null;
    let flushGeneration = 0;
    let outgoingChain = Promise.resolve();
    let ringStartedAt = Date.now();

    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });

    const session = {
      done,
      waitForEnd() {
        return done;
      },
      getOutcome() {
        return finalOutcome;
      },
      async pushAudioToOwner(base64Pcm24k) {
        if (ended || !page || !base64Pcm24k) return 0;
        const b64 =
          typeof base64Pcm24k === 'string'
            ? base64Pcm24k
            : Buffer.isBuffer(base64Pcm24k)
              ? base64Pcm24k.toString('base64')
              : base64Pcm24k instanceof Int16Array
                ? int16ToBase64(base64Pcm24k)
                : '';
        if (!b64) return 0;

        const gen = flushGeneration;
        const run = async () => {
          if (ended || gen !== flushGeneration) return 0;
          try {
            return await page.evaluate(
              (payload) => window.__wpJarvisAudio?.pushOutgoingBase64Pcm?.(payload, 24000) ?? 0,
              b64
            );
          } catch {
            return 0;
          }
        };
        outgoingChain = outgoingChain.then(run, run);
        return outgoingChain;
      },
      async flushAudioToOwner() {
        flushGeneration += 1;
        if (ended || !page) return 0;
        try {
          return await page.evaluate(() => window.__wpJarvisAudio?.flushOutgoingPcm?.() ?? 0);
        } catch {
          return 0;
        }
      },
      async hangUp(reason = 'caller_hangup') {
        if (finalizePromise) return finalizePromise;
        if (!wasConnected) {
          if (reason === 'ring_timeout') {
            timedOut = true;
          } else {
            hasError = true;
          }
        }
        return finalize(null, { reason, shouldClickHangup: true });
      },
    };

    async function finalize(outcomeOverride, details = {}) {
      if (finalizePromise) return finalizePromise;
      finalizePromise = (async () => {
        ended = true;

        if (ringTimer) {
          clearTimeout(ringTimer);
          ringTimer = null;
        }
        if (maxDurationTimer) {
          clearTimeout(maxDurationTimer);
          maxDurationTimer = null;
        }
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }

        if (bridge) {
          bridge.onAudio = null;
          bridge.onState = null;
        }

        if (onPageClose && page) {
          try {
            if (typeof page.off === 'function') {
              page.off('close', onPageClose);
            } else if (typeof page.removeListener === 'function') {
              page.removeListener('close', onPageClose);
            }
          } catch {
            // Ignore listener detach errors on closed page
          }
        }

        await outgoingChain.catch(() => {});

        if (details.shouldClickHangup) {
          await clickHangup();
        }

        if (page) {
          await page
            .evaluate(() => {
              if (window.__wpJarvisAudio) {
                window.__wpJarvisAudio.flushOutgoingPcm?.();
                window.__wpJarvisAudio.flushIncomingBridge?.();
                window.__wpJarvisAudio.configureBridge?.({ enabled: false });
              }
            })
            .catch(() => {});
        }

        const outcome =
          outcomeOverride ||
          classifyCallOutcome({
            wasConnected,
            timedOut,
            endedEarlyWhileRinging,
            hasError,
          });
        finalOutcome = outcome;

        if (activeCall === session) {
          activeCall = null;
        }

        try {
          await onEnded?.(outcome, details);
        } catch {
          // Do not prevent session completion if caller onEnded throws
        }

        resolveDone(outcome);
        return outcome;
      })();
      return finalizePromise;
    }

    if (!page || (!isIncoming && !ownerPhone)) {
      hasError = true;
      await finalize('error', {
        reason: !page ? 'missing_page' : 'missing_owner_phone',
      });
      return session;
    }

    activeCall = session;

    function handleOnConnectedError(err) {
      if (ended) return;
      hasError = true;
      void finalize('error', {
        reason: 'onConnected_failed',
        error: err,
        shouldClickHangup: true,
      });
    }

    function markConnected() {
      if (ended || wasConnected) return;
      wasConnected = true;

      if (ringTimer) {
        clearTimeout(ringTimer);
        ringTimer = null;
      }

      const maxMs = toTimeoutMs(config.callMaxDurationSec, 300);
      maxDurationTimer = setTimeout(() => {
        void session.hangUp('max_duration');
      }, maxMs);

      try {
        Promise.resolve(onConnected?.(session)).catch(handleOnConnectedError);
      } catch (err) {
        handleOnConnectedError(err);
      }
    }

    function isPcForThisCall(pcId) {
      if (pcId === undefined || pcId === null) return true;
      return pcId > baselinePcCount || callPcIds.has(pcId) || preExistingActivePcIds.has(pcId);
    }

    function isEventForThisCall(evt) {
      if (!evt || typeof evt !== 'object') return false;
      if (evt.pcId === undefined || evt.pcId === null) return true;
      if (evt.type === 'pc_created' && evt.pcId > baselinePcCount) {
        callPcIds.add(evt.pcId);
        return true;
      }
      return isPcForThisCall(evt.pcId);
    }

    try {
      onPageClose = () => {
        if (ended) return;
        if (!wasConnected) hasError = true;
        void finalize(wasConnected ? 'answered' : 'error', { reason: 'page_closed' });
      };
      if (typeof page.on === 'function') {
        page.on('close', onPageClose);
      }

      if (isIncoming) {
        await ensureHookPresent(page, hookScript);
        if (ended) return session;
        bridge = await ensurePageBridge(page);
      } else {
        const navResult = await openOwnerChat(page, ownerPhone, ownerChatId, chatOpenSettleMs);
        if (ended) return session;
        if (navResult.navigated) {
          bridge = await verifyOrReinstateBridgeAfterNavigation(page, hookScript);
          await Promise.resolve(client?.ensureIncomingCallObserver?.()).catch(() => {});
        } else {
          bridge = await ensurePageBridge(page);
        }
      }
      if (ended) return session;

      const initTelemetry = await page
        .evaluate((incoming, batchSamples) => {
          if (!window.__wpJarvisAudio) return null;
          const telemetry = window.__wpJarvisAudio.getTelemetry?.() || {};
          window.__wpJarvisAudio.flushOutgoingPcm?.();
          window.__wpJarvisAudio.resetTelemetry?.();
          window.__wpJarvisAudio.configureBridge?.({
            enabled: !incoming,
            batchSamples,
          });
          return telemetry;
        }, isIncoming, bridgeBatchSamples)
        .catch(() => null);
      if (ended) return session;

      baselinePcCount = initTelemetry?.hookedPeerConnectionCount || 0;
      if (isIncoming && Array.isArray(initTelemetry?.peerConnections)) {
        for (const p of initTelemetry.peerConnections) {
          if (!isPcTerminal(p, false)) {
            preExistingActivePcIds.add(p.id);
          }
        }
      }

      bridge.onAudio = (b64, meta) => {
        if (ended) return;
        try {
          onAudioFromOwner?.(b64, meta);
        } catch {
          // Isolate consumer callback errors from WebRTC bridge
        }
      };

      bridge.onState = (evt) => {
        if (ended || !isEventForThisCall(evt)) return;
        const pcKey = evt.pcId ?? '__default__';
        const prev = callPcStates.get(pcKey) || {
          connectionState: 'new',
          iceConnectionState: 'new',
        };
        const updated = {
          connectionState: evt.connectionState ?? prev.connectionState,
          iceConnectionState: evt.iceConnectionState ?? prev.iceConnectionState,
        };
        callPcStates.set(pcKey, updated);

        const allTerminal =
          callPcStates.size > 0 &&
          Array.from(callPcStates.values()).every((s) => isPcTerminal(s, false));
        if (!allTerminal) return;

        if (!wasConnected) {
          if (isIncoming) {
            timedOut = true;
            void finalize('missed', { reason: 'webrtc_closed_while_ringing', evt });
          } else {
            endedEarlyWhileRinging = true;
            void finalize('rejected', { reason: 'webrtc_closed_while_ringing', evt });
          }
        } else {
          void finalize('answered', { reason: 'remote_webrtc_closed', evt });
        }
      };

      const targetSelectors = isIncoming ? INCOMING_ACCEPT_SELECTORS : AUDIO_CALL_SELECTORS;
      const clicked = await clickButtonWithRetries(
        page,
        targetSelectors,
        callButtonRetryCount,
        callButtonRetryDelayMs,
        () => ended
      );
      if (ended) return session;
      if (!clicked) {
        if (isIncoming) {
          timedOut = true;
          await finalize('missed', { reason: 'incoming_accept_button_not_found' });
        } else {
          hasError = true;
          await finalize('error', { reason: 'audio_call_button_not_found' });
        }
        return session;
      }

      if (isIncoming) {
        // Enable audio bridge only after Accept is clicked so ringtone audio never leaks into Gemini.
        await page
          .evaluate((batchSamples) => {
            if (!window.__wpJarvisAudio) return;
            window.__wpJarvisAudio.resetTelemetry?.();
            window.__wpJarvisAudio.configureBridge?.({ enabled: true, batchSamples });
          }, bridgeBatchSamples)
          .catch(() => {});
        if (ended) return session;
      }

      ringStartedAt = Date.now();
      const ringTimeoutMs = isIncoming
        ? toTimeoutMs(config.callAnswerConnectTimeoutSec ?? config.callRingTimeoutSec, 20)
        : toTimeoutMs(config.callRingTimeoutSec, 35);
      ringTimer = setTimeout(() => {
        if (ended || wasConnected) return;
        void session.hangUp('ring_timeout');
      }, ringTimeoutMs);

      const pollOnce = async () => {
        if (ended) {
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
          return;
        }
        if (pollingInFlight) return;
        pollingInFlight = true;
        try {
          const [domState, telemetry, waCallInfo] = await Promise.all([
            page.evaluate(analyzeCallDomFromDocument, HANGUP_SELECTORS).catch(() => null),
            page.evaluate(() => window.__wpJarvisAudio?.getTelemetry?.() || null).catch(() => null),
            readWaCallState(page),
          ]);

          if (ended) {
            if (pollTimer) {
              clearInterval(pollTimer);
              pollTimer = null;
            }
            return;
          }

          if (waCallInfo?.hasActiveCall) {
            sawWaActiveCallOnce = true;
          }

          const hasDomState = Boolean(domState && typeof domState === 'object');
          if (hasDomState && domState.hangupPresent) {
            sawHangupOnce = true;
          }

          const pcs = Array.isArray(telemetry?.peerConnections)
            ? telemetry.peerConnections.filter((p) => isPcForThisCall(p.id))
            : [];

          // WhatsApp Web connects DataChannel peer connections while ringing.
          // Rely on live DOM timer (`0:00`) or WAWebCallCollection connected state after Accept.
          if (
            !wasConnected &&
            (Boolean(hasDomState && domState.timerText) ||
              (isIncoming && Boolean(hasDomState && domState.hangupPresent && waCallInfo?.isInConnectedCall)))
          ) {
            markConnected();
          }

          if (!wasConnected) {
            const hints = hasDomState && Array.isArray(domState.statusHints) ? domState.statusHints : [];
            const noAnswerHint = hints.some((h) => NO_ANSWER_STATUS_HINTS.has(h));
            if (noAnswerHint) {
              timedOut = true;
              await finalize('missed', {
                reason: 'dom_no_answer',
                shouldClickHangup: Boolean(domState.hangupPresent),
              });
              return;
            }

            const rejectedHint = hints.some((h) => REJECTED_STATUS_HINTS.has(h));
            const waEndedEarly = Boolean(isIncoming && sawWaActiveCallOnce && waCallInfo && !waCallInfo.hasActiveCall);
            const earlyDomClose =
              hasDomState &&
              sawHangupOnce &&
              !domState.hangupPresent &&
              !domState.hasCallContainer &&
              Date.now() - ringStartedAt >= earlyCloseGraceMs;
            const pcEndedEarly = pcs.length > 0 && pcs.every((p) => isPcTerminal(p, false));

            if (rejectedHint || waEndedEarly || earlyDomClose || pcEndedEarly) {
              const reason = rejectedHint
                ? 'dom_declined'
                : waEndedEarly
                  ? 'wa_call_ended_before_connect'
                  : pcEndedEarly
                    ? 'webrtc_closed_while_ringing'
                    : 'dom_closed_while_ringing';
              if (isIncoming) {
                timedOut = true;
                await finalize('missed', { reason });
              } else {
                endedEarlyWhileRinging = true;
                await finalize('rejected', { reason });
              }
            }
            return;
          }

          const domHangupClosed =
            hasDomState && sawHangupOnce && !domState.hangupPresent && !domState.hasCallContainer;
          const postConnectEndedHint =
            hasDomState && (domState.statusHints || []).some((h) => ENDED_STATUS_HINTS.has(h));
          const waEndedAfterConnect = Boolean(
            sawWaActiveCallOnce && waCallInfo && !waCallInfo.hasActiveCall
          );
          const pcClosed =
            pcs.length > 0 &&
            pcs.every((p) => isPcTerminal(p, hasDomState && !domState.hangupPresent));

          if (domHangupClosed || pcClosed || postConnectEndedHint || waEndedAfterConnect) {
            await finalize('answered', {
              reason: pcClosed
                ? 'remote_webrtc_closed'
                : waEndedAfterConnect
                  ? 'wa_call_ended'
                  : postConnectEndedHint
                    ? 'remote_dom_ended_hint'
                    : 'remote_dom_closed',
            });
          }
        } finally {
          pollingInFlight = false;
        }
      };

      if (ended) return session;
      pollTimer = setInterval(() => {
        void pollOnce();
      }, Math.max(5, pollIntervalMs));

      return session;
    } catch (err) {
      if (ended) return session;
      hasError = true;
      await finalize('error', { reason: 'call_setup_error', error: err });
      return session;
    }
  }

  return {
    isCallActive() {
      return activeCall !== null;
    },

    startCallWithOwner(handlers = {}) {
      return runCallSession({ ...handlers, mode: 'outgoing' });
    },

    answerIncomingCall(handlers = {}) {
      return runCallSession({ ...handlers, mode: 'incoming' });
    },
  };
}
