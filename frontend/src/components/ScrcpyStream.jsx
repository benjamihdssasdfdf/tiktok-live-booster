import React, { useEffect, useRef, useState } from 'react';
import JMuxer from 'jmuxer';
import { Activity, AlertCircle, RefreshCw, Smartphone, Radio, Volume2, VolumeX, Wifi, WifiOff, Terminal, CheckCircle2 } from 'lucide-react';

/**
 * TikTok Booster - Pixel-Perfect Scrcpy Real-Time Screen Stream & Remote Touch Controller
 * Decodes continuous H.264 video at ~30 FPS via JMuxer MSE and translates pointer
 * events into pixel-perfect 32-byte Scrcpy touch and 14-byte keycode control packets.
 */
export default function ScrcpyStream({
  runnerKey,
  token,
  wsBaseUrl,
  deviceWidth = 1080,
  deviceHeight = 2400,
  runnerTelemetry = {},
  onControlDispatched = null
}) {
  const videoRef = useRef(null);
  const jmuxerRef = useRef(null);
  const wsRef = useRef(null);
  const containerRef = useRef(null);
  const isPointerDownRef = useRef(false);
  const activePointerIdRef = useRef(null);

  // Explicit Stream States: CONNECTING | LIVE | RECONNECTING | DISCONNECTED | ERROR
  const [streamState, setStreamState] = useState('CONNECTING');
  const [fps, setFps] = useState(0);
  const [kbps, setKbps] = useState(0);
  const [framesReceived, setFramesReceived] = useState(0);
  const [touchRipples, setTouchRipples] = useState([]);
  const [diagnosticMode, setDiagnosticMode] = useState(true);
  const [diagnosticLog, setDiagnosticLog] = useState('');
  const [reconnectCount, setReconnectCount] = useState(0);

  // Authoritative status values
  const isRunnerAlive = runnerTelemetry.state !== 'OFFLINE' && runnerTelemetry.state !== 'STOPPED' && runnerTelemetry.state !== 'UNREGISTERED' && runnerTelemetry.heartbeat !== 'OFFLINE';
  const isAdbConnected = runnerTelemetry.adb_state === 'OK';
  const isAndroidReady = ['ANDROID_READY', 'STARTING', 'APP_STARTING', 'APP_STARTED', 'LOGIN_REQUIRED', 'LOGIN_SUBMITTING', '2FA_REQUIRED', 'AUTHENTICATED', 'OPENING_LIVE', 'TARGET_OPENING', 'TARGET_VERIFIED', 'WATCHING', 'RUNNING', 'RECOVERING'].includes(runnerTelemetry.state);
  const isTikTokRunning = runnerTelemetry.app_state === 'RUNNING' || ['APP_STARTED', 'LOGIN_REQUIRED', 'LOGIN_SUBMITTING', '2FA_REQUIRED', 'AUTHENTICATED', 'OPENING_LIVE', 'TARGET_OPENING', 'TARGET_VERIFIED', 'WATCHING', 'RUNNING'].includes(runnerTelemetry.state);
  const isTargetActive = ['TARGET_VERIFIED', 'WATCHING', 'RUNNING'].includes(runnerTelemetry.state);
  const isVideoLive = streamState === 'LIVE';

  // 1. Dynamic Video Frame Dimensions
  const getActiveStreamDimensions = () => {
    if (videoRef.current && videoRef.current.videoWidth > 0 && videoRef.current.videoHeight > 0) {
      return {
        width: videoRef.current.videoWidth,
        height: videoRef.current.videoHeight
      };
    }
    return {
      width: deviceWidth || (runnerTelemetry.display_width || 1080),
      height: deviceHeight || (runnerTelemetry.display_height || 2400)
    };
  };

  // 2. Initialize Transport with Resilient Auto-Reconnect
  useEffect(() => {
    let frameCount = 0;
    let bytesCount = 0;
    let isCancelled = false;
    let abortController = new AbortController();
    let isLiveStreaming = false;
    let reconnectTimeout = null;

    const statsInterval = setInterval(() => {
      setFps(frameCount);
      setKbps(Math.round((bytesCount * 8) / 1024));
      frameCount = 0;
      bytesCount = 0;
    }, 1000);

    const initJMuxer = () => {
      if (videoRef.current && !jmuxerRef.current) {
        try {
          jmuxerRef.current = new JMuxer({
            node: videoRef.current,
            mode: 'video',
            flv: false,
            fps: 30,
            clearBuffer: true,
            maxDelay: 60,
            debug: false
          });
        } catch (err) {
          console.debug('JMuxer init notice:', err);
        }
      }
    };

    const cleanupVideoAndDecoder = () => {
      if (videoRef.current) {
        try {
          videoRef.current.pause();
        } catch (_) {}
      }
      if (jmuxerRef.current) {
        try {
          jmuxerRef.current.destroy();
        } catch (_) {}
        jmuxerRef.current = null;
      }
    };

    initJMuxer();

    const handleH264Chunk = (chunkBuffer) => {
      if (!chunkBuffer || chunkBuffer.byteLength === 0) return;
      frameCount++;
      bytesCount += chunkBuffer.byteLength;
      setFramesReceived(prev => prev + 1);

      if (!jmuxerRef.current) {
        initJMuxer();
      }

      if (!isLiveStreaming) {
        isLiveStreaming = true;
        setStreamState('LIVE');
      }

      if (jmuxerRef.current) {
        try {
          jmuxerRef.current.feed({
            video: new Uint8Array(chunkBuffer)
          });

          if (videoRef.current) {
            if (videoRef.current.paused) {
              videoRef.current.play().catch(() => {});
            }

            // Real-Time Live Edge Locking (<120ms latency)
            if (videoRef.current.buffered && videoRef.current.buffered.length > 0) {
              const end = videoRef.current.buffered.end(videoRef.current.buffered.length - 1);
              const current = videoRef.current.currentTime;
              if (end - current > 0.18) {
                videoRef.current.currentTime = Math.max(0, end - 0.02);
              }
            }
          }
        } catch (e) {
          console.debug('JMuxer feed notice:', e);
        }
      }
    };

    const connectStream = () => {
      if (isCancelled) return;
      let wsEstablished = false;
      const rawWsUrl = `${wsBaseUrl.replace('http://', 'ws://').replace('https://', 'wss://')}/ws/stream?role=browser&runner_key=${runnerKey}&token=${token || ''}`;

      // HTTP Stream Fallback
      const startHttpFetchStream = async () => {
        if (isCancelled || wsEstablished) return;
        const httpStreamUrl = `${wsBaseUrl}/api/stream/live/${runnerKey}?token=${token || ''}`;
        try {
          const response = await fetch(httpStreamUrl, {
            signal: abortController.signal,
            headers: { Authorization: `Bearer ${token || ''}` }
          });

          if (response.ok && response.body) {
            const reader = response.body.getReader();
            while (!isCancelled && !wsEstablished) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value && value.buffer) {
                handleH264Chunk(value.buffer);
              }
            }
          }
        } catch (err) {
          if (!isCancelled && err.name !== 'AbortError') {
            triggerReconnect();
          }
        }
      };

      const triggerReconnect = () => {
        if (isCancelled) return;
        setStreamState('RECONNECTING');
        setReconnectCount(c => c + 1);
        clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => {
          if (!isCancelled) connectStream();
        }, 2000);
      };

      try {
        const ws = new WebSocket(rawWsUrl);
        ws.binaryType = 'arraybuffer';
        wsRef.current = ws;

        ws.onopen = () => {
          wsEstablished = true;
          setStreamState('LIVE');
        };

        ws.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            wsEstablished = true;
            handleH264Chunk(event.data);
          }
        };

        ws.onerror = () => {
          if (!wsEstablished && !isCancelled) {
            startHttpFetchStream();
          }
        };

        ws.onclose = () => {
          if (!isCancelled) {
            if (!isLiveStreaming) {
              startHttpFetchStream();
            } else {
              triggerReconnect();
            }
          }
        };
      } catch (err) {
        startHttpFetchStream();
      }
    };

    connectStream();

    return () => {
      isCancelled = true;
      isLiveStreaming = false;
      abortController.abort();
      clearTimeout(reconnectTimeout);
      clearInterval(statsInterval);
      cleanupVideoAndDecoder();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [runnerKey, wsBaseUrl, token]);

  // Purge frozen browser video buffer immediately when runner goes offline
  useEffect(() => {
    if (!isRunnerAlive) {
      if (videoRef.current) {
        try {
          videoRef.current.pause();
          videoRef.current.removeAttribute('src');
          videoRef.current.load();
        } catch (_) {}
      }
      if (jmuxerRef.current) {
        try {
          jmuxerRef.current.destroy();
        } catch (_) {}
        jmuxerRef.current = null;
      }
    }
  }, [isRunnerAlive]);

  // 3. Pixel-Perfect Coordinate Mapping (Accounts for Letterboxing / Aspect Ratio / Stream Res)
  const calculateDeviceCoordinates = (clientX, clientY) => {
    if (!containerRef.current) return null;
    const containerRect = containerRef.current.getBoundingClientRect();
    const { width: streamW, height: streamH } = getActiveStreamDimensions();

    const deviceAspect = streamW / streamH;
    const containerAspect = containerRect.width / containerRect.height;

    let renderW = containerRect.width;
    let renderH = containerRect.height;
    let renderLeft = containerRect.left;
    let renderTop = containerRect.top;

    if (containerAspect > deviceAspect) {
      renderW = containerRect.height * deviceAspect;
      renderLeft = containerRect.left + (containerRect.width - renderW) / 2;
    } else {
      renderH = containerRect.width / deviceAspect;
      renderTop = containerRect.top + (containerRect.height - renderH) / 2;
    }

    const clickRelX = clientX - renderLeft;
    const clickRelY = clientY - renderTop;

    const clampedX = Math.max(0, Math.min(renderW, clickRelX));
    const clampedY = Math.max(0, Math.min(renderH, clickRelY));

    const androidX = Math.round((clampedX / renderW) * streamW);
    const androidY = Math.round((clampedY / renderH) * streamH);

    const diag = `browser=(${Math.round(clientX)},${Math.round(clientY)}) ➔ video=(${Math.round(clampedX)},${Math.round(clampedY)}) ➔ android=(${androidX},${androidY}), resolution=${streamW}x${streamH}, rotation=0`;
    setDiagnosticLog(diag);
    if (diagnosticMode) {
      console.log(`[TOUCH_DIAGNOSTIC] ${diag}`);
    }

    return {
      androidX: Math.max(0, Math.min(streamW, androidX)),
      androidY: Math.max(0, Math.min(streamH, androidY)),
      streamW,
      streamH,
      visualX: clientX - containerRect.left,
      visualY: clientY - containerRect.top,
      diag
    };
  };

  // 4. Binary Scrcpy Packet Serializers with Dual Transport Dispatch
  const sendScrcpyTouch = (action, clientX, clientY, pointerId = 0) => {
    const coords = calculateDeviceCoordinates(clientX, clientY);
    if (!coords) return;

    // Visual Touch Ripple on Down
    if (action === 0) {
      const rId = Date.now();
      setTouchRipples(prev => [...prev, { id: rId, x: coords.visualX, y: coords.visualY }]);
      setTimeout(() => setTouchRipples(prev => prev.filter(r => r.id !== rId)), 400);
    }

    // Build 32-Byte Scrcpy Touch Packet (>BBQIIHHHII)
    const buffer = new ArrayBuffer(32);
    const view = new DataView(buffer);

    view.setUint8(0, 0x02);                     // TYPE = 2 (INJECT_TOUCH)
    view.setUint8(1, action);                   // ACTION (0=DOWN, 1=UP, 2=MOVE)
    view.setBigUint64(2, BigInt(pointerId));    // POINTER ID
    view.setUint32(10, coords.androidX);        // X
    view.setUint32(14, coords.androidY);        // Y
    view.setUint16(18, coords.streamW);         // WIDTH
    view.setUint16(20, coords.streamH);         // HEIGHT
    view.setUint16(22, 0xffff);                 // PRESSURE (1.0)
    view.setUint32(24, 1);                      // ACTION_BUTTON (PRIMARY)
    view.setUint32(28, 1);                      // BUTTONS (PRIMARY)

    // 1. Send via WebSocket if open
    let sentWs = false;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(buffer);
      sentWs = true;
    }

    // 2. Also dispatch via HTTP control endpoint for reliability
    if (!sentWs || action === 0) {
      fetch(`${wsBaseUrl}/api/stream/control/${runnerKey}?token=${token || ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token || ''}` },
        body: buffer
      }).catch(() => {});
    }

    if (onControlDispatched && action === 0) {
      onControlDispatched(`Touch (${coords.androidX}, ${coords.androidY}) [${coords.streamW}x${coords.streamH}]`);
    }
  };

  const sendScrcpyKey = (keycode) => {
    if (streamState !== 'LIVE') return;
    const sendKeyAction = (action) => {
      const buffer = new ArrayBuffer(14);
      const view = new DataView(buffer);
      view.setUint8(0, 0x00);        // TYPE = 0 (INJECT_KEYCODE)
      view.setUint8(1, action);      // ACTION (0=DOWN, 1=UP)
      view.setUint32(2, keycode);    // KEYCODE
      view.setUint32(6, 0);          // REPEAT (0)
      view.setUint32(10, 0);         // METASTATE (0)

      let sentWs = false;
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(buffer);
        sentWs = true;
      }
      if (!sentWs) {
        fetch(`${wsBaseUrl}/api/stream/control/${runnerKey}?token=${token || ''}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token || ''}` },
          body: buffer
        }).catch(() => {});
      }
    };

    sendKeyAction(0);
    setTimeout(() => sendKeyAction(1), 40);
    if (onControlDispatched) onControlDispatched(`Keyevent ${keycode}`);
  };

  const handlePointerDown = (e) => {
    if (streamState !== 'LIVE') return;
    e.preventDefault();
    isPointerDownRef.current = true;
    activePointerIdRef.current = e.pointerId;
    if (containerRef.current) {
      try {
        containerRef.current.setPointerCapture(e.pointerId);
      } catch (_) {}
    }
    sendScrcpyTouch(0, e.clientX, e.clientY, 0);
  };

  const handlePointerMove = (e) => {
    if (streamState !== 'LIVE' || !isPointerDownRef.current) return;
    e.preventDefault();
    sendScrcpyTouch(2, e.clientX, e.clientY, 0);
  };

  const handlePointerUp = (e) => {
    if (streamState !== 'LIVE' || !isPointerDownRef.current) return;
    e.preventDefault();
    isPointerDownRef.current = false;
    if (containerRef.current && activePointerIdRef.current !== null) {
      try {
        containerRef.current.releasePointerCapture(activePointerIdRef.current);
      } catch (_) {}
    }
    activePointerIdRef.current = null;
    sendScrcpyTouch(1, e.clientX, e.clientY, 0);
  };

  const streamDims = getActiveStreamDimensions();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      
      {/* 8-Point Authoritative Health Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginBottom: 6, fontSize: 10 }}>
        <div style={{ background: isRunnerAlive ? 'rgba(0, 245, 155, 0.1)' : 'rgba(255, 100, 100, 0.1)', color: isRunnerAlive ? 'var(--accent-green)' : '#ff6b6b', padding: '3px 4px', borderRadius: 4, textAlign: 'center', fontWeight: 700 }}>
          {isRunnerAlive ? '● Runner Online' : '○ Runner Offline'}
        </div>
        <div style={{ background: isAndroidReady ? 'rgba(0, 245, 155, 0.1)' : 'rgba(255, 170, 0, 0.1)', color: isAndroidReady ? 'var(--accent-green)' : '#ffa800', padding: '3px 4px', borderRadius: 4, textAlign: 'center', fontWeight: 700 }}>
          {isAndroidReady ? '● Android Ready' : '○ Booting AVD'}
        </div>
        <div style={{ background: isTikTokRunning ? 'rgba(0, 245, 155, 0.1)' : 'rgba(37, 244, 238, 0.1)', color: isTikTokRunning ? 'var(--accent-green)' : 'var(--tiktok-cyan)', padding: '3px 4px', borderRadius: 4, textAlign: 'center', fontWeight: 700 }}>
          {isTikTokRunning ? '● TikTok Active' : '○ App Standby'}
        </div>
        <div style={{ background: isVideoLive ? 'rgba(0, 245, 155, 0.1)' : 'rgba(255, 170, 0, 0.1)', color: isVideoLive ? 'var(--accent-green)' : '#ffa800', padding: '3px 4px', borderRadius: 4, textAlign: 'center', fontWeight: 700 }}>
          {isVideoLive ? `● Live ${fps} FPS` : '○ Stream Connecting'}
        </div>
      </div>

      {/* Stream Status Banner & Diagnostic Mode Toggle */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.85)', padding: '5px 10px', borderRadius: 8, marginBottom: 6, fontSize: 11 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ 
            width: 8, height: 8, borderRadius: '50%', 
            background: !isRunnerAlive ? '#FF6B8B' : (streamState === 'LIVE' ? 'var(--accent-green)' : (streamState === 'RECONNECTING' ? '#FFA800' : 'var(--tiktok-cyan)')),
            boxShadow: (isRunnerAlive && streamState === 'LIVE') ? '0 0 8px #00F59B' : 'none'
          }} />
          <span style={{ fontWeight: 700, color: !isRunnerAlive ? '#FF6B8B' : (streamState === 'LIVE' ? 'var(--accent-green)' : (streamState === 'RECONNECTING' ? '#FFA800' : 'var(--tiktok-cyan)')) }}>
            {!isRunnerAlive && 'RUNNER OFFLINE • NO FEED'}
            {isRunnerAlive && streamState === 'LIVE' && `LIVE SCREEN • ${streamDims.width}x${streamDims.height}`}
            {isRunnerAlive && streamState === 'CONNECTING' && `INITIALIZING STREAM...`}
            {isRunnerAlive && streamState === 'RECONNECTING' && `RECONNECTING (#${reconnectCount})...`}
            {isRunnerAlive && streamState === 'DISCONNECTED' && `STREAM PAUSED`}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            onClick={() => setDiagnosticMode(!diagnosticMode)}
            style={{ background: diagnosticMode ? 'rgba(37, 244, 238, 0.2)' : 'transparent', border: '1px solid var(--border-subtle)', color: diagnosticMode ? 'var(--tiktok-cyan)' : 'var(--text-muted)', borderRadius: 4, padding: '2px 6px', fontSize: 10, cursor: 'pointer' }}
          >
            {diagnosticMode ? 'HUD Active' : 'HUD Off'}
          </button>
          <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{kbps} kbps</span>
        </div>
      </div>

      {/* Real-time Diagnostic HUD */}
      {diagnosticMode && diagnosticLog && (
        <div style={{ background: 'rgba(5, 10, 20, 0.85)', border: '1px solid rgba(37, 244, 238, 0.3)', borderRadius: 6, padding: '3px 8px', marginBottom: 6, fontSize: 10, color: 'var(--tiktok-cyan)', fontFamily: 'var(--font-mono)', textAlign: 'left', wordBreak: 'break-all' }}>
          ⚡ {diagnosticLog}
        </div>
      )}

      {/* Main Viewport Container */}
      <div 
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: `${streamDims.width} / ${streamDims.height}`,
          maxHeight: '65vh',
          background: '#000',
          borderRadius: 10,
          border: '1px solid rgba(37, 244, 238, 0.3)',
          overflow: 'hidden',
          cursor: streamState === 'LIVE' ? 'crosshair' : 'default',
          touchAction: 'none',
          userSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 0 25px rgba(0,0,0,0.9)'
        }}
      >
        {/* Touch Ripple Visualizer */}
        {touchRipples.map(r => (
          <span 
            key={r.id} 
            style={{
              position: 'absolute',
              left: r.x - 16,
              top: r.y - 16,
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: 'rgba(37, 244, 238, 0.45)',
              border: '2px solid #25F4EE',
              pointerEvents: 'none',
              transform: 'scale(1)',
              animation: 'ripple 0.4s ease-out forwards',
              zIndex: 20
            }} 
          />
        ))}

        {/* Video Canvas Element - strictly active when live and online */}
        <video 
          ref={videoRef}
          muted
          autoPlay
          playsInline
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            pointerEvents: 'none',
            display: (isRunnerAlive && streamState === 'LIVE') ? 'block' : 'none'
          }}
        />

        {/* Explicit Offline or Waiting State */}
        {!isRunnerAlive ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: '#FF6B8B', padding: 24, textAlign: 'center' }}>
            <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(254, 44, 85, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>
              ⏹️
            </div>
            <span style={{ fontSize: 13, fontWeight: 800 }}>Runner is Offline</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              The cloud Android session is terminated. No active live video feed.
            </span>
          </div>
        ) : streamState !== 'LIVE' ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: 'var(--text-muted)', padding: 20 }}>
            <Activity className="animate-spin" size={32} color="var(--tiktok-cyan)" />
            <span style={{ fontSize: 12, fontWeight: 600 }}>
              {isAndroidReady ? 'Connecting Live Stream Transport...' : 'Waiting for Android 14 AVD Boot...'}
            </span>
          </div>
        ) : null}
      </div>

      {/* Android Hardware Navigation Bar (Back, Home, App Switcher) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 8 }}>
        <button
          type="button"
          disabled={streamState !== 'LIVE'}
          onClick={() => sendScrcpyKey(4)} // KEYCODE_BACK
          className="btn-secondary"
          style={{ padding: '7px 4px', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, opacity: streamState === 'LIVE' ? 1 : 0.45, cursor: streamState === 'LIVE' ? 'pointer' : 'not-allowed' }}
          title={streamState === 'LIVE' ? "Back (KEYCODE_BACK 4)" : "Interactions disabled (No active live session)"}
        >
          ◀ Back
        </button>
        <button
          type="button"
          disabled={streamState !== 'LIVE'}
          onClick={() => sendScrcpyKey(3)} // KEYCODE_HOME
          className="btn-secondary"
          style={{ padding: '7px 4px', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, opacity: streamState === 'LIVE' ? 1 : 0.45, cursor: streamState === 'LIVE' ? 'pointer' : 'not-allowed' }}
          title={streamState === 'LIVE' ? "Home (KEYCODE_HOME 3)" : "Interactions disabled (No active live session)"}
        >
          ● Home
        </button>
        <button
          type="button"
          disabled={streamState !== 'LIVE'}
          onClick={() => sendScrcpyKey(187)} // KEYCODE_APP_SWITCH
          className="btn-secondary"
          style={{ padding: '7px 4px', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, opacity: streamState === 'LIVE' ? 1 : 0.45, cursor: streamState === 'LIVE' ? 'pointer' : 'not-allowed' }}
          title={streamState === 'LIVE' ? "Switch Apps (KEYCODE_APP_SWITCH 187)" : "Interactions disabled (No active live session)"}
        >
          ■ Switch
        </button>
      </div>

    </div>
  );
}
