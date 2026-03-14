import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Upload, Play, Pause, Download, Trash2, Image as ImageIcon, Film, Loader2, ZoomIn, ZoomOut, Check, Crop, X, Settings, Smartphone, Monitor, Music, PlusCircle, GripVertical, Square, Instagram, Save, FolderOpen, Menu, ChevronDown, Volume2, StopCircle, Move, CloudDownload, LogOut } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { db, type Project } from './services/storage';
import * as googlePhotos from './services/googlePhotos';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

type Rect = { x: number, y: number, w: number, h: number };
type KenBurnsMode = 'zoom-in' | 'zoom-out' | 'pan';
type Orientation = 'landscape' | 'portrait' | 'square' | 'instagram' | 'classic' | 'custom';
type ExportFormat = 'webm' | 'mp4';

type RGB = { r: number, g: number, b: number };

const ASPECT_RATIOS: Record<Exclude<Orientation, 'custom'>, number> = {
  landscape: 16 / 9,
  portrait: 9 / 16,
  square: 1 / 1,
  instagram: 4 / 5,
  classic: 4 / 3
};

const RESOLUTIONS: Record<Exclude<Orientation, 'custom'>, { w: number, h: number }> = {
  landscape: { w: 1280, h: 720 },
  portrait: { w: 720, h: 1280 },
  square: { w: 1080, h: 1080 },
  instagram: { w: 1080, h: 1350 },
  classic: { w: 1024, h: 768 }
};

type PlaylistItem = {
  id: string;
  type: 'image' | 'video';
  file: File;
  url: string;
  element: HTMLImageElement | HTMLVideoElement;
  rect: Rect;
  mode: KenBurnsMode;
  duration: number;
  customTitle?: string;
  dominantColor: RGB;
  trimStart: number;
  trimEnd: number;
  originalDuration: number;
  panStart?: Rect;
  panEnd?: Rect;
};

const getDominantColor = (source: HTMLImageElement | HTMLVideoElement): RGB => {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { r: 0, g: 0, b: 0 };
    ctx.drawImage(source, 0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    return { r: data[0], g: data[1], b: data[2] };
  } catch (e) {
    console.warn('Failed to get dominant color', e);
    return { r: 20, g: 20, b: 20 };
  }
};

const getSupportedMimeType = (format: ExportFormat) => {
  const mp4Types = [
    'video/mp4;codecs=h264,aac',
    'video/mp4;codecs=h264,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=avc1',
    'video/mp4'
  ];
  
  const webmTypes = [
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=h264',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];

  if (format === 'mp4') {
    for (const type of mp4Types) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    // If MP4 not supported, try H264 in WebM as it's more compatible when renamed
    for (const type of webmTypes) {
      if (type.includes('h264') && MediaRecorder.isTypeSupported(type)) return type;
    }
  }

  for (const type of webmTypes) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  
  return '';
};

function ImageEditor({ 
  item, 
  projectTitle, 
  orientation, 
  customWidth, 
  customHeight, 
  onSave, 
  onCancel 
}: { 
  item: PlaylistItem, 
  projectTitle: string, 
  orientation: Orientation, 
  customWidth: number, 
  customHeight: number, 
  onSave: (item: PlaylistItem) => void, 
  onCancel: () => void, 
  key?: string | number 
}) {
  const [rect, setRect] = useState(item.rect);
  const [mode, setMode] = useState(item.mode);
  const [duration, setDuration] = useState<string>(String(item.duration / 1000));
  const [trimStart, setTrimStart] = useState<number>(Math.floor(item.trimStart ?? 0));
  const [trimEnd, setTrimEnd] = useState<number>(Math.floor(item.trimEnd ?? item.originalDuration ?? 10));
  const [useDefaultTitle, setUseDefaultTitle] = useState(item.customTitle === undefined);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [customTitle, setCustomTitle] = useState(item.customTitle ?? projectTitle);
  const [panStart, setPanStart] = useState<Rect>(item.panStart ?? item.rect);
  const [panEnd, setPanEnd] = useState<Rect>(item.panEnd ?? item.rect);
  const [panEditTarget, setPanEditTarget] = useState<'start' | 'end'>('start');
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number, startY: number, startRect: Rect, type: 'move' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const isVideo = item.type === 'video';
  const mediaWidth = isVideo ? ((item.element as HTMLVideoElement).videoWidth || 1280) : ((item.element as HTMLImageElement).width || 1);
  const mediaHeight = isVideo ? ((item.element as HTMLVideoElement).videoHeight || 720) : ((item.element as HTMLImageElement).height || 1);
  const realMediaHeight = mediaHeight;

  const imgAspect = mediaWidth / realMediaHeight;
  const frameAspect = orientation === 'custom' ? customWidth / customHeight : ASPECT_RATIOS[orientation];
  
  const maxW = Math.min(1, frameAspect / imgAspect);
  const minW = 0.1 * maxW;

  // Update rect when frameAspect changes to maintain proportions
  useEffect(() => {
    setRect(prev => {
      const newH = prev.w * imgAspect / frameAspect;
      // Center the new height if possible, otherwise clamp
      let y = prev.y + (prev.h - newH) / 2;
      y = Math.max(0, Math.min(1 - newH, y));
      return { ...prev, h: newH, y };
    });
  }, [frameAspect, imgAspect]);

  // Ref to hold latest item to avoid dependency loop
  const itemRef = useRef(item);
  useEffect(() => {
    itemRef.current = item;
  }, [item]);

  useEffect(() => {
    if (isVideo && videoRef.current) {
      const video = videoRef.current;
      
      const handleTimeUpdate = () => {
        if (isScrubbing) return;
        if (video.currentTime >= trimEnd) {
          video.currentTime = trimStart;
        }
        if (video.currentTime < trimStart) {
          video.currentTime = trimStart;
        }
      };

      video.addEventListener('timeupdate', handleTimeUpdate);
      
      if (!isScrubbing) {
        video.currentTime = trimStart;
        video.play().catch(() => {});
      }
      
      return () => {
        video.removeEventListener('timeupdate', handleTimeUpdate);
        video.pause();
      };
    }
  }, [isVideo, trimStart, trimEnd, isScrubbing]);

  // Sync rect changes to the active pan target
  useEffect(() => {
    if (mode === 'pan') {
      if (panEditTarget === 'start') {
        setPanStart(rect);
      } else {
        setPanEnd(rect);
      }
    }
  }, [rect]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const numDuration = isVideo ? (trimEnd - trimStart) : (parseFloat(duration) || 0);

      // Use ref to get latest item properties without triggering effect
      const currentItem = itemRef.current;

      onSave({
        ...currentItem,
        rect,
        mode,
        duration: numDuration * 1000,
        trimStart,
        trimEnd,
        customTitle: useDefaultTitle ? undefined : customTitle,
        panStart: mode === 'pan' ? (panEditTarget === 'start' ? rect : panStart) : undefined,
        panEnd: mode === 'pan' ? (panEditTarget === 'end' ? rect : panEnd) : undefined
      });
    }, 100);
    return () => clearTimeout(timer);
  }, [rect, mode, duration, trimStart, trimEnd, useDefaultTitle, customTitle, onSave, isVideo, panStart, panEnd, panEditTarget]);

  const handlePointerDown = (e: React.PointerEvent, type: 'move' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' = 'move') => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startRect: { ...rect },
      type
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  const handlePointerMove = (e: PointerEvent) => {
    if (!dragRef.current || !containerRef.current) return;
    const { startX, startY, startRect, type } = dragRef.current;
    const bounds = containerRef.current.getBoundingClientRect();

    const dx = (e.clientX - startX) / bounds.width;
    const dy = (e.clientY - startY) / bounds.height;

    if (type === 'move') {
      let x = Math.max(0, Math.min(1 - startRect.w, startRect.x + dx));
      let y = Math.max(0, Math.min(1 - startRect.h, startRect.y + dy));
      setRect(prev => ({ ...prev, x, y }));
    } else {
      // Resizing logic with aspect ratio lock
      let newW = startRect.w;
      let newX = startRect.x;
      let newY = startRect.y;

      if (type === 'top-left') {
        newW = Math.max(minW, Math.min(maxW, startRect.w - dx));
        newX = startRect.x + (startRect.w - newW);
      } else if (type === 'top-right') {
        newW = Math.max(minW, Math.min(maxW, startRect.w + dx));
      } else if (type === 'bottom-left') {
        newW = Math.max(minW, Math.min(maxW, startRect.w - dx));
        newX = startRect.x + (startRect.w - newW);
      } else if (type === 'bottom-right') {
        newW = Math.max(minW, Math.min(maxW, startRect.w + dx));
      }

      const newH = newW * imgAspect / frameAspect;

      // Adjust Y based on corner
      if (type === 'top-left' || type === 'top-right') {
        newY = startRect.y + (startRect.h - newH);
      }

      // Final clamping to bounds
      if (newX < 0) {
        newW += newX;
        newX = 0;
      }
      if (newX + newW > 1) {
        newW = 1 - newX;
      }
      
      // Re-calculate H after clamping W
      const finalH = newW * imgAspect / frameAspect;
      if (newY < 0) {
        newY = 0;
      }
      if (newY + finalH > 1) {
        newY = 1 - finalH;
      }

      setRect({ x: newX, y: newY, w: newW, h: finalH });
    }
  };

  const handlePointerUp = () => {
    dragRef.current = null;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
  };

  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, []);

  const handleScaleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    const newW = minW + (maxW - minW) * (val / 100);
    const newH = newW * imgAspect / frameAspect;

    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;

    let x = cx - newW / 2;
    let y = cy - newH / 2;

    x = Math.max(0, Math.min(1 - newW, x));
    y = Math.max(0, Math.min(1 - newH, y));

    setRect({ x, y, w: newW, h: newH });
  };

  const switchToMode = (newMode: KenBurnsMode) => {
    setMode(newMode);

    if (newMode === 'pan') {
      // Set up default pan start and end rects with maximum height
      let h = 1;
      let w = h * frameAspect / imgAspect;
      if (w > 1) {
        w = 1;
        h = w * imgAspect / frameAspect;
      }

      // Only set defaults if not already configured
      if (!item.panStart || !item.panEnd) {
        let startRect, endRect;
        if (imgAspect < 1) {
          // Portrait image: pan top → bottom
          startRect = { x: (1 - w) / 2, y: 0, w, h };
          endRect = { x: (1 - w) / 2, y: 1 - h, w, h };
        } else {
          // Landscape image: pan left → right
          startRect = { x: 0, y: (1 - h) / 2, w, h };
          endRect = { x: 1 - w, y: (1 - h) / 2, w, h };
        }
        setPanStart(startRect);
        setPanEnd(endRect);
        setRect(startRect);
      } else {
        setRect(panStart);
      }
      setPanEditTarget('start');
    } else {
      // Enforce aspect ratio for Zoom modes
      const currentRectAspect = (rect.w / rect.h) * imgAspect;
      if (Math.abs(currentRectAspect - frameAspect) > 0.01) {
        const maxW = Math.min(1, frameAspect / imgAspect);
        const w = 0.6 * maxW;
        const h = w * imgAspect / frameAspect;
        const x = (1 - w) / 2;
        const y = (1 - h) / 2;
        setRect({ x, y, w, h });
      }
    }
  };

  const currentSliderVal = ((rect.w - minW) / (maxW - minW)) * 100;

  return (
    <div className="space-y-6 bg-zinc-900/50 p-6 rounded-2xl border border-zinc-800">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">Bildausschnitt bearbeiten</h3>
          <p className="text-sm text-zinc-400">Definiere den Zielrahmen und die Dauer für dieses Bild.</p>
        </div>
        <button onClick={onCancel} className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400 transition-colors">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          {isVideo ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm text-zinc-400">Video-Dauer (Sekunden)</label>
                <div className="bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-white font-mono">
                  {trimEnd - trimStart}s
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-sm text-zinc-400">Effekt-Richtung</label>
              <div className="flex gap-2 p-1 bg-zinc-950 rounded-xl border border-zinc-800">
                <button
                  onClick={() => switchToMode('zoom-in')}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-colors ${mode === 'zoom-in' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                  <ZoomIn className="w-4 h-4" /> Reinzoomen
                </button>
                <button
                  onClick={() => switchToMode('zoom-out')}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-colors ${mode === 'zoom-out' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                  <ZoomOut className="w-4 h-4" /> Rauszoomen
                </button>
                <button
                  onClick={() => switchToMode('pan')}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-colors ${mode === 'pan' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                  <Move className="w-4 h-4" /> Kamerafahrt
                </button>
              </div>
              {mode === 'pan' && (
                <div className="mt-3">
                  <label className="text-sm text-zinc-400 mb-2 block">Kameraposition bearbeiten</label>
                  <div className="flex gap-2 p-1 bg-zinc-950 rounded-xl border border-zinc-800">
                    <button
                      onClick={() => { setPanEditTarget('start'); setRect(panStart); }}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-colors ${panEditTarget === 'start' ? 'bg-emerald-600/20 text-emerald-400 shadow-sm border border-emerald-500/30' : 'text-zinc-500 hover:text-zinc-300'}`}
                    >
                      Startposition
                    </button>
                    <button
                      onClick={() => { setPanEditTarget('end'); setRect(panEnd); }}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-colors ${panEditTarget === 'end' ? 'bg-orange-600/20 text-orange-400 shadow-sm border border-orange-500/30' : 'text-zinc-500 hover:text-zinc-300'}`}
                    >
                      Endposition
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Duration input for images */}
        {!isVideo && (
          <div className="space-y-2">
            <label className="text-sm text-zinc-400">Dauer (Sekunden)</label>
            <input
              type="number"
              min="1"
              max="60"
              step="1"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-white font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50"
            />
          </div>
        )}
        {isVideo && (
          <div className="col-span-2 space-y-4 pt-4 border-t border-zinc-800">
            <div className="flex items-center justify-between">
              <label className="text-sm text-zinc-400">Video trimmen (Sekunden)</label>
              <span className="text-xs font-mono text-indigo-400">{trimStart}s - {trimEnd}s</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div className="space-y-2">
                <div className="flex justify-between text-[10px] text-zinc-500 uppercase tracking-wider">
                  <span>Startpunkt</span>
                  <span className="text-zinc-300">{trimStart}s</span>
                </div>
                <input 
                  type="range" 
                  min="0" 
                  max={Math.max(0, Math.floor(item.originalDuration || 10) - 1)} 
                  step="1"
                  value={trimStart}
                  onMouseDown={() => setIsScrubbing(true)}
                  onTouchStart={() => setIsScrubbing(true)}
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    const maxDuration = Math.floor(item.originalDuration || 10);
                    const safeStart = Math.min(val, maxDuration - 1);
                    
                    setTrimStart(safeStart);
                    if (videoRef.current) {
                      videoRef.current.currentTime = safeStart;
                    }
                    
                    // Push trimEnd forward if start lands on or after it
                    setTrimEnd(prev => {
                      if (safeStart >= prev) {
                        return Math.min(safeStart + 1, maxDuration);
                      }
                      return prev;
                    });
                  }}
                  onMouseUp={() => setIsScrubbing(false)}
                  onTouchEnd={() => setIsScrubbing(false)}
                  className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-[10px] text-zinc-500 uppercase tracking-wider">
                  <span>Endpunkt</span>
                  <span className="text-zinc-300">{trimEnd}s</span>
                </div>
                <input 
                  type="range" 
                  min={Math.min(trimStart + 1, Math.floor(item.originalDuration || 10))} 
                  max={Math.floor(item.originalDuration || 10)} 
                  step="1"
                  value={trimEnd}
                  onMouseDown={() => setIsScrubbing(true)}
                  onTouchStart={() => setIsScrubbing(true)}
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    setTrimEnd(val);
                    if (videoRef.current) {
                      videoRef.current.currentTime = val;
                    }
                  }}
                  onMouseUp={() => setIsScrubbing(false)}
                  onTouchEnd={() => setIsScrubbing(false)}
                  className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                />
              </div>
            </div>
          </div>
        )}

        <div className="col-span-2 space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm text-zinc-400">Bild-Titel</label>
            <label className="flex items-center gap-2 text-xs text-zinc-500 cursor-pointer">
              <input 
                type="checkbox" 
                checked={useDefaultTitle}
                onChange={(e) => setUseDefaultTitle(e.target.checked)}
                className="rounded border-zinc-700 bg-zinc-900 text-indigo-600 focus:ring-indigo-500/30"
              />
              Standard verwenden
            </label>
          </div>
          <input 
            type="text" 
            value={useDefaultTitle ? projectTitle : customTitle}
            disabled={useDefaultTitle}
            onChange={(e) => setCustomTitle(e.target.value)}
            placeholder="Titel für dieses Bild..."
            className={`w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-opacity ${useDefaultTitle ? 'opacity-50 cursor-not-allowed' : ''}`}
          />
          {!useDefaultTitle && customTitle === '' && (
            <p className="text-xs text-amber-500/80">Kein Titel wird angezeigt.</p>
          )}
        </div>
      </div>

      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl p-4">
        <div className="relative w-full h-[40vh] min-h-[300px] bg-zinc-900 rounded-lg flex items-center justify-center p-4 overflow-hidden">
          <div 
            ref={containerRef}
            className="relative shadow-2xl overflow-hidden bg-black/20" 
            style={{ 
              aspectRatio: `${mediaWidth} / ${mediaHeight}`, 
              maxHeight: '100%', 
              maxWidth: '100%' 
            }}
          >
            {item.type === 'image' ? (
              <img src={item.url} className="w-full h-full block pointer-events-none" alt="Preview" />
            ) : (
              <video 
                ref={videoRef}
                src={item.url} 
                className="w-full h-full block pointer-events-none object-contain" 
                loop 
                muted 
                playsInline
              />
            )}
            
            {!isVideo && (
              <>
                {/* Ghost rect for the other pan position */}
                {mode === 'pan' && (
                  <div
                    className={`absolute border-2 border-dashed pointer-events-none z-[5] ${panEditTarget === 'start' ? 'border-orange-400/50' : 'border-emerald-400/50'}`}
                    style={{
                      left: `${(panEditTarget === 'start' ? panEnd.x : panStart.x) * 100}%`,
                      top: `${(panEditTarget === 'start' ? panEnd.y : panStart.y) * 100}%`,
                      width: `${(panEditTarget === 'start' ? panEnd.w : panStart.w) * 100}%`,
                      height: `${(panEditTarget === 'start' ? panEnd.h : panStart.h) * 100}%`,
                    }}
                  >
                    <span className={`absolute -top-5 left-1 text-[10px] font-medium ${panEditTarget === 'start' ? 'text-orange-400' : 'text-emerald-400'}`}>
                      {panEditTarget === 'start' ? 'Ende' : 'Start'}
                    </span>
                  </div>
                )}
                <div
                  className={`absolute border-2 shadow-[0_0_0_9999px_rgba(0,0,0,0.6)] cursor-move touch-none group ${
                    mode === 'pan'
                      ? panEditTarget === 'start' ? 'border-emerald-500' : 'border-orange-500'
                      : 'border-indigo-500'
                  }`}
                  style={{
                    left: `${rect.x * 100}%`,
                    top: `${rect.y * 100}%`,
                    width: `${rect.w * 100}%`,
                    height: `${rect.h * 100}%`,
                  }}
                  onPointerDown={handlePointerDown}
                >
                  {mode === 'pan' && (
                    <span className={`absolute -top-5 left-1 text-[10px] font-bold ${panEditTarget === 'start' ? 'text-emerald-400' : 'text-orange-400'}`}>
                      {panEditTarget === 'start' ? 'Start' : 'Ende'}
                    </span>
                  )}
                  <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 pointer-events-none opacity-0 group-hover:opacity-50 transition-opacity">
                    <div className="border-r border-b border-white/50"></div>
                    <div className="border-r border-b border-white/50"></div>
                    <div className="border-b border-white/50"></div>
                    <div className="border-r border-b border-white/50"></div>
                    <div className="border-r border-b border-white/50"></div>
                    <div className="border-b border-white/50"></div>
                    <div className="border-r border-white/50"></div>
                    <div className="border-r border-white/50"></div>
                    <div></div>
                  </div>
                  {(() => {
                    const borderColor = mode === 'pan' ? (panEditTarget === 'start' ? 'border-emerald-500' : 'border-orange-500') : 'border-indigo-500';
                    return (<>
                      <div className={`absolute -top-1.5 -left-1.5 w-4 h-4 bg-white border-2 ${borderColor} rounded-full cursor-nwse-resize z-10 shadow-sm hover:scale-125 transition-transform`} onPointerDown={(e) => handlePointerDown(e, 'top-left')} />
                      <div className={`absolute -top-1.5 -right-1.5 w-4 h-4 bg-white border-2 ${borderColor} rounded-full cursor-nesw-resize z-10 shadow-sm hover:scale-125 transition-transform`} onPointerDown={(e) => handlePointerDown(e, 'top-right')} />
                      <div className={`absolute -bottom-1.5 -left-1.5 w-4 h-4 bg-white border-2 ${borderColor} rounded-full cursor-nesw-resize z-10 shadow-sm hover:scale-125 transition-transform`} onPointerDown={(e) => handlePointerDown(e, 'bottom-left')} />
                      <div className={`absolute -bottom-1.5 -right-1.5 w-4 h-4 bg-white border-2 ${borderColor} rounded-full cursor-nwse-resize z-10 shadow-sm hover:scale-125 transition-transform`} onPointerDown={(e) => handlePointerDown(e, 'bottom-right')} />
                    </>);
                  })()}
                </div>
              </>
            )}
          </div>
        </div>

        {!isVideo && (
          <div className="mt-6 space-y-3 px-2">
            <div className="flex justify-between text-sm">
              <span className="text-zinc-400">Rahmengröße (Zoom-Level)</span>
              <span className="text-zinc-200 font-mono">{Math.round(currentSliderVal)}%</span>
            </div>
            <input 
              type="range" 
              min="0" 
              max="100" 
              step="0.1"
              value={currentSliderVal}
              onChange={handleScaleChange}
              className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
            />
          </div>
        )}
      </div>

      <div className="flex justify-end pt-2">
        {/* Auto-save enabled, no manual save button needed */}
      </div>
    </div>
  );
}

interface SortableItemProps {
  item: PlaylistItem;
  i: number;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  removeItem: (id: string) => void;
  isGenerating: boolean;
  currentProgress: number;
  isActive: boolean;
}

const SortableItem: React.FC<SortableItemProps> = ({ 
  item, 
  i, 
  editingId, 
  setEditingId, 
  removeItem,
  isGenerating,
  currentProgress,
  isActive
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2.5 p-2 border rounded-xl group transition-all duration-200 ${
        isDragging
          ? 'border-indigo-500 bg-zinc-800/80 shadow-2xl shadow-indigo-500/10 z-50 scale-[1.02] opacity-60'
          : isActive && isGenerating
            ? 'border-indigo-500/40 bg-indigo-500/5 active-glow'
            : editingId === item.id
              ? 'border-indigo-500/50 bg-indigo-500/5'
              : 'border-zinc-800/60 bg-zinc-900/30 hover:border-zinc-700 hover:bg-zinc-900/60'
      }`}
    >
      <div
        {...attributes}
        {...listeners}
        className="p-1 text-zinc-700 hover:text-zinc-400 cursor-grab active:cursor-grabbing touch-none transition-colors"
      >
        <GripVertical className="w-3.5 h-3.5" />
      </div>

      <div
        className="relative w-12 h-12 rounded-lg overflow-hidden bg-zinc-950 flex-shrink-0 cursor-pointer ring-1 ring-zinc-800/50"
        onClick={() => setEditingId(item.id)}
      >
        {item.type === 'image' ? (
          <img
            src={item.url}
            alt={`Upload ${i}`}
            className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
          />
        ) : (
          <video
            src={item.url}
            className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
            muted
          />
        )}
        <div className="absolute top-0.5 left-0.5 p-0.5 bg-black/70 backdrop-blur-md rounded text-[7px] font-medium text-white/80">
          {item.type === 'video' ? <Film className="w-2 h-2" /> : <ImageIcon className="w-2 h-2" />}
        </div>
      </div>

      <div
        className="flex-1 min-w-0 cursor-pointer"
        onClick={() => setEditingId(item.id)}
      >
        <p className="text-sm font-medium truncate text-zinc-200 leading-tight">
          {item.customTitle || `Medium ${i + 1}`}
        </p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[10px] font-mono text-zinc-500 tabular-nums">
            {item.type === 'video'
              ? `${Math.round(item.trimEnd - item.trimStart)}s`
              : `${Math.round(item.duration / 1000)}s`}
          </span>
          <span className="text-[9px] text-zinc-600 uppercase tracking-wider bg-zinc-800/60 px-1.5 py-0.5 rounded-md">
            {item.type === 'video'
              ? 'Video'
              : item.mode === 'zoom-in'
                ? 'Zoom+'
                : item.mode === 'zoom-out'
                  ? 'Zoom-'
                  : 'Pan'}
          </span>
        </div>
        {isActive && isGenerating && (
          <div className="mt-1.5 h-1 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full progress-shimmer rounded-full transition-all duration-75 ease-linear"
              style={{ width: `${currentProgress}%` }}
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-0.5 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
        <button
          onClick={() => setEditingId(item.id)}
          className={`p-1.5 rounded-lg transition-colors ${editingId === item.id ? 'text-indigo-400 bg-indigo-500/10' : 'text-zinc-500 hover:text-white hover:bg-zinc-800'}`}
          title="Bearbeiten"
        >
          <Crop className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => removeItem(item.id)}
          className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
          title="Löschen"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [isSetup, setIsSetup] = useState(true);
  const [projectTitle, setProjectTitle] = useState('Mein Video');
  const [orientation, setOrientation] = useState<Orientation>('landscape');
  const [customWidth, setCustomWidth] = useState(1920);
  const [customHeight, setCustomHeight] = useState(1080);
  const [defaultDuration, setDefaultDuration] = useState(8);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('mp4');
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [showTitleOverlay, setShowTitleOverlay] = useState(false);

  const [items, setItems] = useState<PlaylistItem[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'generating' | 'done'>('idle');
  const [progress, setProgress] = useState(0);
  const [currentItemIndex, setCurrentItemIndex] = useState<number | null>(null);
  const [estimatedTimeRemaining, setEstimatedTimeRemaining] = useState<number | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [actualMimeType, setActualMimeType] = useState<string>('');
  const [isProjectManagerOpen, setIsProjectManagerOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [currentProjectId, setCurrentProjectId] = useState<number | null>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  
  const savedProjects = useLiveQuery(() => db.projects.toArray());
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancelGenerationRef = useRef<(() => void) | null>(null);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);

  // Google Photos state
  const [googlePhotosLoading, setGooglePhotosLoading] = useState(false);
  const [googlePhotosError, setGooglePhotosError] = useState<string | null>(null);
  const [googleSignedIn, setGoogleSignedIn] = useState(false);

  // Update all items' rect when project aspect ratio changes
  useEffect(() => {
    if (items.length === 0) return;
    
    const frameAspect = orientation === 'custom' ? customWidth / customHeight : ASPECT_RATIOS[orientation];
    
    setItems(prev => prev.map(item => {
      const imgAspect = item.element.width / item.element.height;
      const currentRectAspect = item.rect.w / item.rect.h;
      
      // If the aspect ratio of the rect is significantly different from the frame aspect, update it
      if (Math.abs(currentRectAspect - frameAspect) > 0.01) {
        const maxW = Math.min(1, frameAspect / imgAspect);
        const w = Math.min(item.rect.w, maxW);
        const h = w * imgAspect / frameAspect;
        
        // Ensure it stays within bounds
        const x = Math.min(item.rect.x, 1 - w);
        const y = Math.min(item.rect.y, 1 - h);
        
        return {
          ...item,
          rect: { x, y, w, h }
        };
      }
      return item;
    }));
  }, [orientation, customWidth, customHeight]);

  const handleAudioUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // More lenient check: mime type or common audio extensions
      const isAudio = file.type.startsWith('audio/') || 
                      /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(file.name);
      
      if (isAudio) {
        setAudioFile(file);
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        setAudioUrl(URL.createObjectURL(file));
      } else {
        alert('Bitte wähle eine gültige Audiodatei aus (MP3, WAV, M4A, etc.).');
      }
    }
    // Reset input to allow re-selecting the same file
    e.target.value = '';
  }, [audioUrl]);

  const removeAudio = useCallback(() => {
    if (audioPreviewRef.current) {
      audioPreviewRef.current.pause();
      audioPreviewRef.current = null;
      setIsAudioPlaying(false);
    }
    setAudioFile(null);
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
  }, [audioUrl]);

  const toggleAudioPreview = useCallback(() => {
    if (isAudioPlaying && audioPreviewRef.current) {
      audioPreviewRef.current.pause();
      audioPreviewRef.current.currentTime = 0;
      audioPreviewRef.current = null;
      setIsAudioPlaying(false);
    } else if (audioUrl) {
      const audio = new Audio(audioUrl);
      audio.onended = () => {
        setIsAudioPlaying(false);
        audioPreviewRef.current = null;
      };
      audio.play().catch(() => {});
      audioPreviewRef.current = audio;
      setIsAudioPlaying(true);
    }
  }, [audioUrl, isAudioPlaying]);

  const handleFiles = useCallback(async (newFiles: File[]) => {
    console.log('[handleFiles] Received files:', newFiles.map(f => `${f.name} (${f.type}, ${f.size})`));

    // Detect video/image by MIME type or file extension
    const isVideoFile = (f: File) => {
      if (f.type.startsWith('video/')) return true;
      const ext = f.name.toLowerCase().split('.').pop();
      return ['mp4', 'mov', 'avi', 'webm', 'mkv', 'm4v', '3gp'].includes(ext || '');
    };
    const isImageFile = (f: File) => {
      if (f.type.startsWith('image/')) return true;
      const ext = f.name.toLowerCase().split('.').pop();
      return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif'].includes(ext || '');
    };

    const validFiles = newFiles.filter(f => isImageFile(f) || isVideoFile(f));
    console.log('[handleFiles] Valid files after filter:', validFiles.map(f => `${f.name} (${f.type}, isVideo: ${isVideoFile(f)})`));
    if (validFiles.length === 0) return;

    const loadedItems = await Promise.all(
      validFiles.map(async (file) => {
        const url = URL.createObjectURL(file);
        const isVideo = isVideoFile(file);
        
        let element: HTMLImageElement | HTMLVideoElement;
        let width = 0;
        let height = 0;
        let itemDuration = defaultDuration * 1000;

        if (isVideo) {
          element = document.createElement('video');
          if (element.src) URL.revokeObjectURL(element.src); // Revoke old URL if exists
          element.src = url;
          element.muted = true;
          element.playsInline = true;
          element.preload = 'auto';
          element.crossOrigin = 'anonymous';
          await new Promise((resolve) => {
            let timeout = setTimeout(() => {
              console.warn('[Video] Load timeout:', (element as HTMLVideoElement).readyState);
              resolve(null);
            }, 10000);
            const checkReady = () => {
              if (width > 0) return;
              if ((element as HTMLVideoElement).videoWidth > 0) {
                clearTimeout(timeout);
                width = (element as HTMLVideoElement).videoWidth;
                height = (element as HTMLVideoElement).videoHeight;
                itemDuration = (element as HTMLVideoElement).duration * 1000;
                if (!itemDuration || !isFinite(itemDuration)) itemDuration = defaultDuration * 1000;
                console.log('[Video] Loaded:', width, 'x', height, 'duration:', itemDuration);
                resolve(null);
              }
            };
            element.addEventListener('loadedmetadata', checkReady);
            element.addEventListener('loadeddata', checkReady);
            element.addEventListener('canplay', checkReady);
            element.onerror = (e) => {
              clearTimeout(timeout);
              const ve = (element as HTMLVideoElement).error;
              console.warn('[Video] Error:', ve?.code, ve?.message);
              resolve(null);
            };
            (element as HTMLVideoElement).load();
          });
        } else {
          element = new Image();
          if (element.src) URL.revokeObjectURL(element.src); // Revoke old URL if exists
          await new Promise((resolve) => {
            element.onload = () => {
              width = (element as HTMLImageElement).width;
              height = (element as HTMLImageElement).height;
              resolve(null);
            };
            element.onerror = () => resolve(null);
            (element as HTMLImageElement).src = url;
          });
        }

        if (!width || !height) return null;

        const mediaAspect = width / height;
        const currentFrameAspect = orientation === 'custom' ? customWidth / customHeight : ASPECT_RATIOS[orientation];

        let x, y, w, h;
        let autoPan = false;
        let panStartRect: Rect | undefined;
        let panEndRect: Rect | undefined;

        // Check if image aspect differs significantly from frame aspect
        const needsPan = (mediaAspect > 1 && currentFrameAspect < mediaAspect * 0.8) ||
                         (mediaAspect < 1 && currentFrameAspect > mediaAspect * 1.2);

        if (needsPan) {
          // Maximum height frame: h as large as possible, w derived from aspect ratio
          h = 1;
          w = h * currentFrameAspect / mediaAspect;
          // If w > 1, cap it and derive h from w instead
          if (w > 1) {
            w = 1;
            h = w * mediaAspect / currentFrameAspect;
          }

          if (mediaAspect >= 1) {
            // Landscape image: pan left → right, vertically centered
            panStartRect = { x: 0, y: (1 - h) / 2, w, h };
            panEndRect = { x: 1 - w, y: (1 - h) / 2, w, h };
          } else {
            // Portrait image: pan top → bottom, horizontally centered
            panStartRect = { x: (1 - w) / 2, y: 0, w, h };
            panEndRect = { x: (1 - w) / 2, y: 1 - h, w, h };
          }
          x = panStartRect.x;
          y = panStartRect.y;
          autoPan = true;
        } else {
          // Default zoom-in behavior
          const maxW = Math.min(1, currentFrameAspect / mediaAspect);
          w = 0.6 * maxW;
          h = w * mediaAspect / currentFrameAspect;
          x = (1 - w) / 2;
          y = (1 - h) / 2;
        }

        const color = getDominantColor(element);

        // Videos: no effects, use full frame, original duration
        if (isVideo) {
          return {
            id: Math.random().toString(36).substring(2, 9),
            type: 'video',
            file,
            url,
            element,
            rect: { x: 0, y: 0, w: 1, h: 1 },
            mode: 'zoom-in' as KenBurnsMode, // ignored for video
            duration: itemDuration,
            dominantColor: color,
            trimStart: 0,
            trimEnd: itemDuration / 1000,
            originalDuration: itemDuration / 1000
          } as PlaylistItem;
        }

        return {
          id: Math.random().toString(36).substring(2, 9),
          type: isVideo ? 'video' : 'image',
          file,
          url,
          element,
          rect: { x, y, w, h },
          mode: (autoPan ? 'pan' : 'zoom-in') as KenBurnsMode,
          panStart: panStartRect,
          panEnd: panEndRect,
          duration: itemDuration,
          dominantColor: color,
          trimStart: 0,
          trimEnd: itemDuration / 1000,
          originalDuration: itemDuration / 1000
        } as PlaylistItem;
      })
    );
    
    const validItems = loadedItems.filter((item): item is PlaylistItem => item !== null);
    setItems(prev => [...prev, ...validItems]);
    setStatus('idle');
    setVideoUrl(null);
  }, [orientation, defaultDuration]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const droppedFiles = Array.from(e.dataTransfer.files);
    handleFiles(droppedFiles);
  }, [handleFiles]);

  // Google Photos functions
  const openGooglePhotos = async () => {
    setGooglePhotosError(null);
    setGooglePhotosLoading(true);

    try {
      await googlePhotos.loadGsi();

      if (!googlePhotos.isSignedIn()) {
        await googlePhotos.requestAccess();
        setGoogleSignedIn(true);
      }

      // Picker UI handles selection - get picked photos directly
      const result = await googlePhotos.listPhotos();
      const photos = result.photos;

      if (photos.length === 0) {
        setGooglePhotosLoading(false);
        return;
      }

      // Download and import directly - no second selection needed
      const files: File[] = [];
      for (const photo of photos) {
        try {
          const file = await googlePhotos.downloadPhoto(photo);
          files.push(file);
        } catch (err) {
          console.warn('Download failed:', photo.filename, err);
        }
      }

      if (files.length > 0) {
        await handleFiles(files);
      } else {
        setGooglePhotosError('Keine Fotos konnten heruntergeladen werden');
      }
    } catch (err) {
      setGooglePhotosError((err as Error).message);
    } finally {
      setGooglePhotosLoading(false);
    }
  };

  const signOutGoogle = () => {
    googlePhotos.signOut();
    setGoogleSignedIn(false);
  };

  const removeItem = (id: string) => {
    setItems(prev => {
      const item = prev.find(i => i.id === id);
      if (item) URL.revokeObjectURL(item.url);
      return prev.filter(i => i.id !== id);
    });
    if (editingId === id) setEditingId(null);
    setStatus('idle');
    setVideoUrl(null);
  };

  const handleSaveEdit = useCallback((updatedItem: PlaylistItem) => {
    setItems(prev => prev.map(i => i.id === updatedItem.id ? updatedItem : i));
  }, []);

  const generateVideo = async () => {
    if (items.length === 0 || !canvasRef.current) return;
    setStatus('generating');
    setProgress(0);
    setCurrentItemIndex(0);
    setEstimatedTimeRemaining(null);
    setVideoUrl(null);

    try {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error("Canvas 2D context not available");
      
      const res = orientation === 'custom' ? { w: customWidth, h: customHeight } : RESOLUTIONS[orientation];
      canvas.width = res.w;
      canvas.height = res.h;

      const captureStreamFn = canvas.captureStream || (canvas as any).mozCaptureStream || (canvas as any).webkitCaptureStream;
      if (!captureStreamFn) {
        throw new Error("Video-Aufnahme wird von diesem Browser nicht unterstützt.");
      }
      const canvasStream = captureStreamFn.call(canvas, 24);
      
      let finalStream = canvasStream;
      let audioCtx: AudioContext | null = null;
      let audioSource: AudioBufferSourceNode | null = null;
      let gainNode: GainNode | null = null;

      if (audioUrl) {
        try {
          // Use a standard sample rate for better compatibility
          audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
            sampleRate: 44100
          });
          
          if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
          }
          const dest = audioCtx.createMediaStreamDestination();
          
          const response = await fetch(audioUrl);
          if (!response.ok) throw new Error(`Audio fetch failed: ${response.statusText}`);
          const arrayBuffer = await response.arrayBuffer();
          const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
          
          audioSource = audioCtx.createBufferSource();
          audioSource.buffer = audioBuffer;
          audioSource.loop = true;
          
          gainNode = audioCtx.createGain();
          audioSource.connect(gainNode);
          gainNode.connect(dest);
          
          // Also connect to destination so user can hear it during generation if they want
          // audioSource.connect(audioCtx.destination); 
          audioSource.start(0);

          const audioTracks = dest.stream.getAudioTracks();
          const videoTracks = canvasStream.getVideoTracks();
          
          if (audioTracks.length > 0 && videoTracks.length > 0) {
            finalStream = new MediaStream([
              videoTracks[0],
              audioTracks[0]
            ]);
          } else if (audioTracks.length > 0) {
            console.warn("No video tracks found in canvas stream, but audio tracks found.");
            // Fallback: try to add audio tracks to canvas stream
            audioTracks.forEach(track => canvasStream.addTrack(track));
            finalStream = canvasStream;
          }
        } catch (err) {
          console.error("Error setting up audio:", err);
          alert("Hinweis: Die Audiodatei konnte nicht geladen werden. Das Video wird ohne Ton erstellt.");
        }
      }

      const mimeType = getSupportedMimeType(exportFormat);
      setActualMimeType(mimeType);
      
      const options = mimeType ? { 
        mimeType,
        videoBitsPerSecond: 5000000 // 5 Mbps
      } : {
        videoBitsPerSecond: 5000000
      };
      
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(finalStream, options);
      } catch (err) {
        console.error("Failed to create MediaRecorder with options:", options, err);
        recorder = new MediaRecorder(finalStream);
      }
      
      const chunks: BlobPart[] = [];

      recorder.ondataavailable = e => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = () => {
        cancelGenerationRef.current = null;
        if (cancelled) return; // Don't create video if cancelled
        const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
        setVideoUrl(URL.createObjectURL(blob));
        setStatus('done');
        setCurrentItemIndex(null);
        setEstimatedTimeRemaining(null);
        if (audioSource) {
          audioSource.stop();
          audioSource.disconnect();
        }
        if (audioCtx) {
          audioCtx.close();
        }
      };

      const TRANSITION = 1000;
      const FPS = 24;
      const frameDuration = 1000 / FPS;
      let lastFrameTime = 0;
      const seekedItems = new Set<string>();
      
      let totalDuration = 0;
      const timings = items.map((item, i) => {
        const start = i === 0 ? 0 : totalDuration - TRANSITION;
        const end = start + item.duration;
        totalDuration = end;
        return { start, end, duration: item.duration };
      });

      // Schedule audio fade-out
      if (gainNode && audioCtx) {
        const fadeOutDuration = 2; // seconds
        const videoDurationSec = totalDuration / 1000;
        const now = audioCtx.currentTime;
        const fadeOutStartTime = now + Math.max(0, videoDurationSec - fadeOutDuration);
        
        gainNode.gain.setValueAtTime(1, fadeOutStartTime);
        gainNode.gain.linearRampToValueAtTime(0, now + videoDurationSec);
      }

      let startTime: number | null = null;
      let generationStartTime = Date.now();
      let animationFrame: number;
      let cancelled = false;

      // Store cancel function
      cancelGenerationRef.current = () => {
        cancelled = true;
        cancelAnimationFrame(animationFrame);
        if (recorder.state === 'recording') {
          recorder.stop();
        }
        if (audioSource) {
          audioSource.stop();
          audioSource.disconnect();
        }
        if (audioCtx) {
          audioCtx.close();
        }
        setStatus('idle');
        setProgress(0);
        setCurrentItemIndex(null);
        setEstimatedTimeRemaining(null);
        cancelGenerationRef.current = null;
      };

      const draw = (timestamp: number) => {
        try {
          if (cancelled) return;
          if (!startTime) startTime = timestamp;

          // Throttle to 24fps
          if (timestamp - lastFrameTime < frameDuration) {
            animationFrame = requestAnimationFrame(draw);
            return;
          }
          lastFrameTime = timestamp;

          const t = timestamp - startTime;

          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          let activeItem = null;
          let nextItem = null;

          // Find active and next items for transition
          for (let i = 0; i < items.length; i++) {
            const timing = timings[i];
            if (t >= timing.start && t <= timing.end) {
              activeItem = items[i];
              // Check if we are in transition with next item
              if (i < items.length - 1 && t > timings[i+1].start) {
                nextItem = items[i+1];
              }
              
              // Process active item
              const localT = (t - timing.start) / timing.duration;
              renderItem(activeItem, i, localT, timing, t);
              
              // Process next item if in transition
              if (nextItem) {
                const nextTiming = timings[i+1];
                const nextLocalT = (t - nextTiming.start) / nextTiming.duration;
                renderItem(nextItem, i + 1, nextLocalT, nextTiming, t);
              }

              // Pause all other videos to save CPU
              items.forEach((item, idx) => {
                if (item.type === 'video' && idx !== i && idx !== i + 1) {
                  (item.element as HTMLVideoElement).pause();
                }
              });
              break;
            }
          }

          function renderItem(item: PlaylistItem, i: number, localT: number, timing: any, t: number) {
            // Determine easing based on mode
            let easeT;
            if (item.mode === 'pan') {
              easeT = localT;
            } else {
              easeT = 1 - Math.pow(1 - localT, 5);
            }

            const element = item.element;
            const isVideo = item.type === 'video';
            const mediaWidth = isVideo ? (element as HTMLVideoElement).videoWidth : (element as HTMLImageElement).width;
            const mediaHeight = isVideo ? (element as HTMLVideoElement).videoHeight : (element as HTMLImageElement).height;

            if (isVideo) {
               const video = element as HTMLVideoElement;
               const trimStart = item.trimStart || 0;
               const trimEnd = item.trimEnd || item.originalDuration;
               const trimDuration = trimEnd - trimStart;
               const idealVideoTime = trimStart + localT * trimDuration;
               
               if (!seekedItems.has(item.id)) {
                 video.currentTime = idealVideoTime;
                 seekedItems.add(item.id);
                 video.play().catch(() => {});
               }
               
               if (video.paused && t < timing.end) {
                 video.play().catch(() => {});
               }
            }

            const baseScale = Math.max(canvas.width / mediaWidth, canvas.height / mediaHeight);
            const baseDx = (canvas.width - mediaWidth * baseScale) / 2;
            const baseDy = (canvas.height - mediaHeight * baseScale) / 2;

            const fw = item.rect.w * mediaWidth;
            const fh = item.rect.h * mediaHeight;
            const fx = item.rect.x * mediaWidth;
            const fy = item.rect.y * mediaHeight;

            const targetScale = Math.max(canvas.width / fw, canvas.height / fh);
            const targetDx = -fx * targetScale + (canvas.width - fw * targetScale) / 2;
            const targetDy = -fy * targetScale + (canvas.height - fh * targetScale) / 2;

            let currentScale, currentDx, currentDy;

            if (isVideo) {
              // Fill canvas (cover) and center the video
              currentScale = Math.max(canvas.width / mediaWidth, canvas.height / mediaHeight);
              currentDx = (canvas.width - mediaWidth * currentScale) / 2;
              currentDy = (canvas.height - mediaHeight * currentScale) / 2;
            } else if (item.mode === 'zoom-in') {
              currentScale = baseScale + (targetScale - baseScale) * easeT;
              currentDx = baseDx + (targetDx - baseDx) * easeT;
              currentDy = baseDy + (targetDy - baseDy) * easeT;
            } else if (item.mode === 'zoom-out') {
              currentScale = targetScale + (baseScale - targetScale) * easeT;
              currentDx = targetDx + (baseDx - targetDx) * easeT;
              currentDy = targetDy + (baseDy - targetDy) * easeT;
            } else {
              // Pan mode: interpolate between panStart and panEnd rects
              const ps = item.panStart || item.rect;
              const pe = item.panEnd || item.rect;

              const startFw = ps.w * mediaWidth;
              const startFh = ps.h * mediaHeight;
              const startFx = ps.x * mediaWidth;
              const startFy = ps.y * mediaHeight;
              const startScale = Math.max(canvas.width / startFw, canvas.height / startFh);
              const startDx = -startFx * startScale + (canvas.width - startFw * startScale) / 2;
              const startDy = -startFy * startScale + (canvas.height - startFh * startScale) / 2;

              const endFw = pe.w * mediaWidth;
              const endFh = pe.h * mediaHeight;
              const endFx = pe.x * mediaWidth;
              const endFy = pe.y * mediaHeight;
              const endScale = Math.max(canvas.width / endFw, canvas.height / endFh);
              const endDxVal = -endFx * endScale + (canvas.width - endFw * endScale) / 2;
              const endDyVal = -endFy * endScale + (canvas.height - endFh * endScale) / 2;

              currentScale = startScale + (endScale - startScale) * easeT;
              currentDx = startDx + (endDxVal - startDx) * easeT;
              currentDy = startDy + (endDyVal - startDy) * easeT;
            }

            let opacity = 1;
            if (i > 0 && t < timing.start + TRANSITION) {
              opacity = (t - timing.start) / TRANSITION;
            }
            ctx.globalAlpha = opacity;
            ctx.imageSmoothingEnabled = false; // Maximum performance
            
            ctx.drawImage(element, currentDx, currentDy, mediaWidth * currentScale, mediaHeight * currentScale);
          }

          // Draw title overlay
          if (activeItem && showTitleOverlay) {
            const currentTitle = (activeItem as PlaylistItem).customTitle !== undefined ? (activeItem as PlaylistItem).customTitle : projectTitle;
            
            if (currentTitle) {
              ctx.globalAlpha = 1;
              const isLandscape = orientation === 'landscape';
              const fontSize = isLandscape ? 48 : 64;
              // Modern, thinner font - Outfit
              ctx.font = `300 ${fontSize}px "Outfit", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
              ctx.textBaseline = 'top';
              
              const paddingX = isLandscape ? 24 : 32;
              const paddingY = isLandscape ? 16 : 24;
              const maxWidth = canvas.width * 0.8;
              const lineHeight = fontSize * 1.2;

              // Text Wrapping Logic
              const words = currentTitle.split(' ');
              let line = '';
              const lines = [];

              for (let n = 0; n < words.length; n++) {
                const testLine = line + words[n] + ' ';
                const metrics = ctx.measureText(testLine);
                const testWidth = metrics.width;
                if (testWidth > maxWidth && n > 0) {
                  lines.push(line);
                  line = words[n] + ' ';
                } else {
                  line = testLine;
                }
              }
              lines.push(line);

              // Calculate box dimensions based on lines
              let maxLineWidth = 0;
              lines.forEach(l => {
                const m = ctx.measureText(l);
                if (m.width > maxLineWidth) maxLineWidth = m.width;
              });

              const boxWidth = maxLineWidth + paddingX * 2;
              const boxHeight = (lines.length * lineHeight) + paddingY * 2;
              
              // Position: Bottom Left, closer to edge
              const x = isLandscape ? 30 : 30;
              const y = canvas.height - (isLandscape ? 40 : 60) - boxHeight;
              
              // Draw Shadow for the box - Disabled during generation for performance
              // ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
              // ctx.shadowBlur = 15;
              // ctx.shadowOffsetX = 0;
              // ctx.shadowOffsetY = 6;
              
              // Background Gradient - Dynamic based on image
              const { r, g, b } = (activeItem as PlaylistItem).dominantColor || { r: 20, g: 20, b: 20 };
              const gradient = ctx.createLinearGradient(x, y, x, y + boxHeight);
              // Darken the dominant color for better text contrast
              const r1 = Math.max(0, r - 50);
              const g1 = Math.max(0, g - 50);
              const b1 = Math.max(0, b - 50);
              
              gradient.addColorStop(0, `rgba(${r1}, ${g1}, ${b1}, 0.6)`);
              gradient.addColorStop(1, `rgba(${Math.max(0, r1-30)}, ${Math.max(0, g1-30)}, ${Math.max(0, b1-30)}, 0.8)`);
              ctx.fillStyle = gradient;
              
              // Manual Rounded Rect
              const radius = 16;
              ctx.beginPath();
              ctx.moveTo(x + radius, y);
              ctx.lineTo(x + boxWidth - radius, y);
              ctx.quadraticCurveTo(x + boxWidth, y, x + boxWidth, y + radius);
              ctx.lineTo(x + boxWidth, y + boxHeight - radius);
              ctx.quadraticCurveTo(x + boxWidth, y + boxHeight, x + boxWidth - radius, y + boxHeight);
              ctx.lineTo(x + radius, y + boxHeight);
              ctx.quadraticCurveTo(x, y + boxHeight, x, y + boxHeight - radius);
              ctx.lineTo(x, y + radius);
              ctx.quadraticCurveTo(x, y, x + radius, y);
              ctx.closePath();
              ctx.fill();
              
              // Border (Inner glow effect) - More subtle
              ctx.shadowColor = 'transparent';
              ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
              ctx.lineWidth = 1;
              ctx.stroke();
              
              // Text
              ctx.fillStyle = '#ffffff';
              // ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
              // ctx.shadowBlur = 4;
              // ctx.shadowOffsetX = 0;
              // ctx.shadowOffsetY = 2;
              
              // Draw lines
              lines.forEach((l, i) => {
                ctx.fillText(l.trim(), x + paddingX, y + paddingY + (i * lineHeight));
              });
              
              // Reset
              ctx.shadowColor = 'transparent';
              ctx.shadowBlur = 0;
              ctx.shadowOffsetX = 0;
              ctx.shadowOffsetY = 0;
            }
          }

          // Calculate per-image progress
          let currentImageProgress = 0;
          let activeIdx = 0;
          for (let i = 0; i < timings.length; i++) {
            if (t >= timings[i].start && t <= timings[i].end) {
              activeIdx = i;
              currentImageProgress = ((t - timings[i].start) / timings[i].duration) * 100;
              break;
            }
          }
          
          setCurrentItemIndex(prev => prev !== activeIdx ? activeIdx : prev);
          const roundedProgress = Math.round(currentImageProgress);
          setProgress(prev => prev !== roundedProgress ? roundedProgress : prev);

          // Estimated time remaining
          const elapsedRealTime = Date.now() - generationStartTime;
          if (t > 500 && elapsedRealTime > 500) {
            const generationSpeed = t / elapsedRealTime;
            const remainingVideoTime = totalDuration - t;
            const estimatedRealTimeRemaining = Math.round((remainingVideoTime / generationSpeed) / 1000);
            setEstimatedTimeRemaining(prev => prev !== estimatedRealTimeRemaining ? estimatedRealTimeRemaining : prev);
          }

          if (t < totalDuration) {
            animationFrame = requestAnimationFrame(draw);
          } else {
            // Ensure the last frame is rendered
            const lastT = totalDuration;
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            // Re-render last item at its end state
            const lastIdx = items.length - 1;
            const lastItem = items[lastIdx];
            const lastTiming = timings[lastIdx];
            renderItem(lastItem, lastIdx, 1, lastTiming, lastT);

            // Small delay before stopping to ensure the last frame is encoded
            setTimeout(() => {
              if (recorder && recorder.state === 'recording') {
                recorder.stop();
              }
            }, 200);
          }
        } catch (err) {
          console.error("Animation loop error:", err);
          if (recorder && recorder.state === 'recording') {
            recorder.stop();
          }
          setStatus('idle');
          setCurrentItemIndex(null);
          setEstimatedTimeRemaining(null);
          alert("Fehler beim Rendern: " + (err as Error).message);
        }
      };

      recorder.start();
      // Initial draw to avoid black first frame
      draw(performance.now());
    } catch (err) {
      console.error(err);
      setStatus('idle');
      alert('Fehler bei der Videoerstellung: ' + (err as Error).message);
    }
  };

  const resetProject = () => {
    if (confirm('Möchtest du wirklich ein neues Projekt starten? Alle aktuellen Bilder und Einstellungen gehen verloren.')) {
      items.forEach(item => URL.revokeObjectURL(item.url));
      setItems([]);
      setVideoUrl(null);
      setEditingId(null);
      setStatus('idle');
      setIsSetup(true);
      setProjectTitle('Mein Video');
      setAudioFile(null);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
      setCurrentProjectId(null);
    }
  };

  const saveProject = async () => {
    setIsSaving(true);
    try {
      const projectData: Project = {
        title: projectTitle,
        updatedAt: Date.now(),
        orientation,
        customWidth,
        customHeight,
        defaultDuration,
        exportFormat,
        showTitleOverlay,
        audioFile: audioFile || undefined,
        items: items.map(item => ({
          id: item.id,
          type: item.type,
          file: item.file,
          rect: item.rect,
          mode: item.mode,
          duration: item.duration,
          customTitle: item.customTitle,
          dominantColor: item.dominantColor,
          trimStart: item.trimStart,
          trimEnd: item.trimEnd,
          originalDuration: item.originalDuration,
          panStart: item.panStart,
          panEnd: item.panEnd
        }))
      };

      if (currentProjectId) {
        projectData.id = currentProjectId;
      }
      
      const id = await db.projects.put(projectData);
      setCurrentProjectId(id as number);
      alert('Projekt erfolgreich gespeichert!');
    } catch (err) {
      console.error('Failed to save project:', err);
      alert('Fehler beim Speichern des Projekts.');
    } finally {
      setIsSaving(false);
    }
  };

  const loadProject = async (project: Project) => {
    try {
      // Clear current project
      items.forEach(item => URL.revokeObjectURL(item.url));
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      
      setProjectTitle(project.title);
      setOrientation(project.orientation);
      setCustomWidth(project.customWidth);
      setCustomHeight(project.customHeight);
      setDefaultDuration(project.defaultDuration);
      setExportFormat(project.exportFormat);
      setShowTitleOverlay(project.showTitleOverlay);
      setCurrentProjectId(project.id || null);
      
      if (project.audioFile) {
        setAudioFile(project.audioFile);
        setAudioUrl(URL.createObjectURL(project.audioFile));
      } else {
        setAudioFile(null);
        setAudioUrl(null);
      }

      const loadedItems = await Promise.all(project.items.map(async (item) => {
        const url = URL.createObjectURL(item.file);
        let element: HTMLImageElement | HTMLVideoElement;
        
        if (item.type === 'video') {
          element = document.createElement('video');
          element.src = url;
          element.muted = true;
          element.playsInline = true;
          await new Promise((resolve) => {
            element.onloadedmetadata = () => resolve(null);
            element.onerror = () => resolve(null);
          });
        } else {
          element = new Image();
          await new Promise((resolve) => {
            element.onload = () => resolve(null);
            element.onerror = () => resolve(null);
            element.src = url;
          });
        }

        return {
          ...item,
          url,
          element
        } as PlaylistItem;
      }));

      setItems(loadedItems);
      setIsSetup(false);
      setIsProjectManagerOpen(false);
      setStatus('idle');
      setVideoUrl(null);
    } catch (err) {
      console.error('Failed to load project:', err);
      alert('Fehler beim Laden des Projekts.');
    }
  };

  const deleteProject = async (id: number) => {
    if (confirm('Projekt wirklich löschen?')) {
      await db.projects.delete(id);
    }
  };

  const clearAllItems = () => {
    if (confirm('Alle Medien aus der Liste entfernen?')) {
      items.forEach(item => URL.revokeObjectURL(item.url));
      setItems([]);
      setVideoUrl(null);
      setEditingId(null);
      setStatus('idle');
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      setItems((items) => {
        const oldIndex = items.findIndex((item) => item.id === active.id);
        const newIndex = items.findIndex((item) => item.id === over.id);

        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  const editingItem = items.find(i => i.id === editingId);
  
  const getFileExtension = () => {
    if (actualMimeType.includes('mp4')) return 'mp4';
    if (exportFormat === 'mp4') return 'mp4'; // Fallback naming if browser doesn't strictly support mp4 mime but we requested it
    return 'webm';
  };

  if (isSetup && items.length === 0) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans flex items-center justify-center p-4 sm:p-6 selection:bg-indigo-500/30">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
          className="w-full max-w-xl bg-zinc-900/60 backdrop-blur-2xl border border-zinc-800/60 rounded-3xl p-6 sm:p-8 shadow-2xl"
        >
          <div className="flex items-center gap-3 mb-7">
            <div className="w-11 h-11 bg-indigo-500/15 rounded-2xl flex items-center justify-center">
              <Film className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Neues Projekt</h1>
              <p className="text-sm text-zinc-500">Ken Burns Video erstellen</p>
            </div>
          </div>

          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-300">Projekt-Titel</label>
              <input 
                type="text" 
                value={projectTitle}
                onChange={e => setProjectTitle(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-shadow"
                placeholder="Mein Urlaubsvideo"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-300">Format</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <button
                  onClick={() => setOrientation('landscape')}
                  className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${orientation === 'landscape' ? 'bg-indigo-500/10 border-indigo-500 text-indigo-400' : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700'}`}
                >
                  <Monitor className="w-6 h-6" />
                  <div className="text-center">
                    <p className="text-xs font-medium">YouTube / TV</p>
                    <p className="text-[10px] opacity-60">16:9 Quer</p>
                  </div>
                </button>
                <button
                  onClick={() => setOrientation('portrait')}
                  className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${orientation === 'portrait' ? 'bg-indigo-500/10 border-indigo-500 text-indigo-400' : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700'}`}
                >
                  <Smartphone className="w-6 h-6" />
                  <div className="text-center">
                    <p className="text-xs font-medium">TikTok / WhatsApp</p>
                    <p className="text-[10px] opacity-60">9:16 Hoch</p>
                  </div>
                </button>
                <button
                  onClick={() => setOrientation('square')}
                  className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${orientation === 'square' ? 'bg-indigo-500/10 border-indigo-500 text-indigo-400' : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700'}`}
                >
                  <Square className="w-6 h-6" />
                  <div className="text-center">
                    <p className="text-xs font-medium">Instagram Post</p>
                    <p className="text-[10px] opacity-60">1:1 Quadrat</p>
                  </div>
                </button>
                <button
                  onClick={() => setOrientation('instagram')}
                  className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${orientation === 'instagram' ? 'bg-indigo-500/10 border-indigo-500 text-indigo-400' : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700'}`}
                >
                  <Instagram className="w-6 h-6" />
                  <div className="text-center">
                    <p className="text-xs font-medium">Insta Portrait</p>
                    <p className="text-[10px] opacity-60">4:5 Hoch</p>
                  </div>
                </button>
                <button
                  onClick={() => setOrientation('classic')}
                  className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${orientation === 'classic' ? 'bg-indigo-500/10 border-indigo-500 text-indigo-400' : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700'}`}
                >
                  <PlusCircle className="w-6 h-6" />
                  <div className="text-center">
                    <p className="text-xs font-medium">Klassisch</p>
                    <p className="text-[10px] opacity-60">4:3 Format</p>
                  </div>
                </button>
                <button
                  onClick={() => setOrientation('custom')}
                  className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${orientation === 'custom' ? 'bg-indigo-500/10 border-indigo-500 text-indigo-400' : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700'}`}
                >
                  <Settings className="w-6 h-6" />
                  <div className="text-center">
                    <p className="text-xs font-medium">Eigene Maße</p>
                    <p className="text-[10px] opacity-60">Frei wählbar</p>
                  </div>
                </button>
              </div>
            </div>

            {orientation === 'custom' && (
              <div className="grid grid-cols-2 gap-4 p-4 bg-zinc-950 border border-zinc-800 rounded-2xl animate-in fade-in slide-in-from-top-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">Breite (px)</label>
                  <input 
                    type="number" 
                    value={customWidth}
                    onChange={e => setCustomWidth(Math.max(1, Number(e.target.value)))}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">Höhe (px)</label>
                  <input 
                    type="number" 
                    value={customHeight}
                    onChange={e => setCustomHeight(Math.max(1, Number(e.target.value)))}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-sm font-medium text-zinc-300">Standard-Dauer pro Bild</label>
                <div className="relative">
                  <input 
                    type="number" 
                    min="1" 
                    max="30" 
                    step="0.5"
                    value={defaultDuration}
                    onChange={e => setDefaultDuration(Number(e.target.value))}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-shadow"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 text-sm">Sek.</span>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-zinc-300">Export-Format</label>
                <div className="flex bg-zinc-950 border border-zinc-800 rounded-xl p-1">
                  <button
                    onClick={() => setExportFormat('mp4')}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${exportFormat === 'mp4' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
                  >
                    MP4
                  </button>
                  <button
                    onClick={() => setExportFormat('webm')}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${exportFormat === 'webm' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
                  >
                    WebM
                  </button>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-300">Hintergrundmusik (Optional)</label>
              <div className="flex items-center gap-3">
                <label className="flex-1 bg-zinc-950 border border-zinc-800 hover:border-indigo-500/50 rounded-xl px-4 py-3 text-zinc-400 cursor-pointer transition-colors flex items-center justify-between">
                  <span className="truncate">{audioFile ? audioFile.name : 'Audiodatei auswählen...'}</span>
                  <Music className="w-5 h-5 text-zinc-500" />
                  <input type="file" accept="audio/*" className="hidden" onChange={handleAudioUpload} />
                </label>
                {audioFile && (
                  <button
                    onClick={toggleAudioPreview}
                    className={`p-3 bg-zinc-950 border rounded-xl transition-colors ${isAudioPlaying ? 'border-indigo-500 text-indigo-400 bg-indigo-500/10' : 'border-zinc-800 hover:border-indigo-500/50 hover:text-indigo-400 text-zinc-500'}`}
                    title={isAudioPlaying ? 'Stoppen' : 'Anhören'}
                  >
                    {isAudioPlaying ? <Pause className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                  </button>
                )}
                {audioFile && (
                  <button
                    onClick={removeAudio}
                    className="p-3 bg-zinc-950 border border-zinc-800 hover:bg-red-500/10 hover:border-red-500/50 hover:text-red-500 rounded-xl transition-colors text-zinc-500"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                )}
              </div>
            </div>

            <div className="space-y-2 pt-2">
              <label className="flex items-center gap-3 cursor-pointer">
                <div className="relative flex items-center">
                  <input 
                    type="checkbox" 
                    checked={showTitleOverlay}
                    onChange={e => setShowTitleOverlay(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-zinc-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-500"></div>
                </div>
                <span className="text-sm font-medium text-zinc-300">Titel im Video einblenden</span>
              </label>
            </div>

            <div className="mt-7 space-y-3">
              <button
                onClick={() => setIsSetup(false)}
                className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-3.5 rounded-2xl transition-all shadow-lg shadow-indigo-500/20 active:scale-[0.98] text-sm"
              >
                Projekt starten
              </button>
              <button
                onClick={() => setIsProjectManagerOpen(true)}
                className="w-full text-sm text-zinc-500 hover:text-indigo-400 flex items-center justify-center gap-2 transition-colors py-2"
              >
                <FolderOpen className="w-4 h-4" /> Projekt laden
              </button>
            </div>
          </div>
        </motion.div>

        {/* Project Manager Modal (also on setup screen) */}
        <AnimatePresence>
          {isProjectManagerOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 lg:p-8">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="absolute inset-0 bg-black/80 backdrop-blur-sm"
                onClick={() => setIsProjectManagerOpen(false)}
              />
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                className="relative w-full max-w-2xl bg-zinc-900 border border-zinc-800/80 rounded-3xl shadow-2xl overflow-hidden"
              >
                <div className="px-6 py-3.5 border-b border-zinc-800/50 flex items-center justify-between bg-zinc-900/95 backdrop-blur-xl">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 bg-indigo-500/15 rounded-lg flex items-center justify-center">
                      <FolderOpen className="w-3.5 h-3.5 text-indigo-400" />
                    </div>
                    <h3 className="font-semibold text-base">Projekte</h3>
                  </div>
                  <button
                    onClick={() => setIsProjectManagerOpen(false)}
                    className="p-2 hover:bg-zinc-800 rounded-xl transition-colors text-zinc-400 hover:text-white"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div className="p-5 max-h-[60vh] overflow-y-auto custom-scrollbar">
                  {!savedProjects || savedProjects.length === 0 ? (
                    <div className="text-center py-12">
                      <div className="w-14 h-14 bg-zinc-800/50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                        <FolderOpen className="w-7 h-7 text-zinc-600" />
                      </div>
                      <p className="text-sm text-zinc-500">Keine Projekte vorhanden</p>
                    </div>
                  ) : (
                    <div className="grid gap-2">
                      {savedProjects.map(project => (
                        <div
                          key={project.id}
                          className="flex items-center justify-between p-3.5 bg-zinc-800/30 border border-zinc-800/50 rounded-xl hover:border-indigo-500/30 hover:bg-zinc-800/50 transition-all group cursor-pointer"
                          onClick={() => loadProject(project)}
                        >
                          <div className="flex-1 min-w-0">
                            <h4 className="font-medium text-sm text-zinc-200 truncate group-hover:text-indigo-400 transition-colors">
                              {project.title}
                            </h4>
                            <p className="text-[11px] text-zinc-600 mt-0.5">
                              {new Date(project.updatedAt).toLocaleDateString()} · {project.items.length} Medien
                            </p>
                          </div>
                          <div className="flex items-center gap-1 ml-3">
                            <button
                              onClick={(e) => { e.stopPropagation(); project.id && deleteProject(project.id); }}
                              className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                              title="Löschen"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-indigo-500/30">
      <header className="border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur-xl sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 sm:h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-indigo-500/15 rounded-xl flex items-center justify-center">
              <Film className="w-4 h-4 text-indigo-400" />
            </div>
            <h1 className="text-base sm:text-lg font-semibold tracking-tight truncate max-w-[200px] sm:max-w-none">{projectTitle || 'Ken Burns Studio'}</h1>
          </div>

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-1">
            <button
              onClick={saveProject}
              disabled={isSaving || items.length === 0}
              className="text-sm text-zinc-400 hover:text-indigo-400 hover:bg-zinc-800/60 flex items-center gap-2 transition-all px-3 py-2 rounded-lg disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Speichern
            </button>
            <button
              onClick={() => setIsProjectManagerOpen(true)}
              className="text-sm text-zinc-400 hover:text-indigo-400 hover:bg-zinc-800/60 flex items-center gap-2 transition-all px-3 py-2 rounded-lg"
            >
              <FolderOpen className="w-4 h-4" /> Projekte
            </button>
            <button
              onClick={resetProject}
              className="text-sm text-zinc-400 hover:text-red-400 hover:bg-red-500/10 flex items-center gap-2 transition-all px-3 py-2 rounded-lg"
            >
              <PlusCircle className="w-4 h-4" /> Neu
            </button>
            <div className="w-px h-5 bg-zinc-800 mx-1" />
            <button
              onClick={() => setIsSetup(true)}
              className="text-sm text-zinc-400 hover:text-white hover:bg-zinc-800/60 flex items-center gap-2 transition-all p-2 rounded-lg"
              title="Projekteinstellungen"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>

          {/* Mobile menu button */}
          <button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="md:hidden p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>

        {/* Mobile menu dropdown */}
        <AnimatePresence>
          {isMobileMenuOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="md:hidden overflow-hidden border-t border-zinc-800/50"
            >
              <div className="px-4 py-3 space-y-1 bg-zinc-900/80">
                <button
                  onClick={() => { saveProject(); setIsMobileMenuOpen(false); }}
                  disabled={isSaving || items.length === 0}
                  className="w-full text-left text-sm text-zinc-300 hover:text-indigo-400 hover:bg-zinc-800/60 flex items-center gap-3 transition-all px-3 py-2.5 rounded-lg disabled:opacity-40"
                >
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Speichern
                </button>
                <button
                  onClick={() => { setIsProjectManagerOpen(true); setIsMobileMenuOpen(false); }}
                  className="w-full text-left text-sm text-zinc-300 hover:text-indigo-400 hover:bg-zinc-800/60 flex items-center gap-3 transition-all px-3 py-2.5 rounded-lg"
                >
                  <FolderOpen className="w-4 h-4" /> Projekte laden
                </button>
                <button
                  onClick={() => { resetProject(); setIsMobileMenuOpen(false); }}
                  className="w-full text-left text-sm text-zinc-300 hover:text-red-400 hover:bg-red-500/10 flex items-center gap-3 transition-all px-3 py-2.5 rounded-lg"
                >
                  <PlusCircle className="w-4 h-4" /> Neues Projekt
                </button>
                <button
                  onClick={() => { setIsSetup(true); setIsMobileMenuOpen(false); }}
                  className="w-full text-left text-sm text-zinc-300 hover:text-white hover:bg-zinc-800/60 flex items-center gap-3 transition-all px-3 py-2.5 rounded-lg"
                >
                  <Settings className="w-4 h-4" /> Projekteinstellungen
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 grid grid-cols-1 lg:grid-cols-12 gap-6 sm:gap-8">

        {/* Left Column: Upload & List */}
        <div className="lg:col-span-4 space-y-5">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <h2 className="text-base font-semibold flex items-center gap-2">
                <span className="w-6 h-6 bg-indigo-500/15 rounded-lg flex items-center justify-center text-xs font-bold text-indigo-400">1</span>
                Medien
              </h2>
              <p className="text-xs text-zinc-500">{items.length} {items.length === 1 ? 'Element' : 'Elemente'}</p>
            </div>
            {items.length > 0 && (
              <button
                onClick={clearAllItems}
                className="text-xs text-zinc-600 hover:text-red-400 flex items-center gap-1.5 transition-colors px-2 py-1 rounded-md hover:bg-red-500/10"
              >
                <Trash2 className="w-3 h-3" /> Alle löschen
              </button>
            )}
          </div>

          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-zinc-800 hover:border-indigo-500/40 hover:bg-indigo-500/5 transition-all duration-300 rounded-2xl p-6 sm:p-8 text-center cursor-pointer group"
          >
            <input
              type="file"
              multiple
              accept="image/*,video/*"
              className="hidden"
              ref={fileInputRef}
              onChange={(e) => handleFiles(Array.from(e.target.files || []))}
            />
            <div className="w-11 h-11 bg-zinc-900 border border-zinc-800 rounded-2xl flex items-center justify-center mx-auto mb-3 group-hover:scale-110 group-hover:border-indigo-500/30 group-hover:bg-indigo-500/10 transition-all duration-300">
              <Upload className="w-5 h-5 text-zinc-500 group-hover:text-indigo-400 transition-colors" />
            </div>
            <p className="font-medium text-sm mb-0.5">Medien hinzufügen</p>
            <p className="text-[11px] text-zinc-600">Klicken oder per Drag & Drop</p>
          </div>

          <button
            onClick={openGooglePhotos}
            className="w-full flex items-center justify-center gap-2.5 px-4 py-3 bg-zinc-900/60 border border-zinc-800/60 hover:border-blue-500/40 hover:bg-blue-500/5 rounded-2xl transition-all group text-sm"
          >
            <svg className="w-5 h-5 text-zinc-400 group-hover:text-blue-400 transition-colors" viewBox="0 0 24 24" fill="none">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" fill="none"/>
              <path d="M12 2v10h10c0-5.52-4.48-10-10-10z" fill="#EA4335"/>
              <path d="M2 12h10V2C6.48 2 2 6.48 2 12z" fill="#4285F4"/>
              <path d="M12 22V12H2c0 5.52 4.48 10 10 10z" fill="#34A853"/>
              <path d="M12 12v10c5.52 0 10-4.48 10-10H12z" fill="#FBBC05"/>
            </svg>
            <span className="text-zinc-400 group-hover:text-blue-400 transition-colors font-medium">Google Fotos</span>
          </button>

          {items.length > 0 && (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between px-1">
                <h3 className="text-[11px] font-medium text-zinc-500 uppercase tracking-widest">Medien-Liste</h3>
                <p className="text-[10px] text-zinc-600 flex items-center gap-1">
                  <GripVertical className="w-3 h-3" /> Sortieren
                </p>
              </div>

              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={items.map(item => item.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-1.5">
                    {items.map((item, i) => (
                      <SortableItem
                        key={item.id}
                        item={item}
                        i={i}
                        editingId={editingId}
                        setEditingId={setEditingId}
                        removeItem={removeItem}
                        isGenerating={status === 'generating'}
                        currentProgress={progress}
                        isActive={currentItemIndex === i}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          )}
        </div>

        {/* Right Column: Preview & Actions - Sticky */}
        <div className="lg:col-span-8 space-y-5 lg:sticky lg:top-20 lg:h-fit">
          <div className="flex items-end justify-between gap-4">
            <div className="space-y-0.5">
              <h2 className="text-base font-semibold flex items-center gap-2">
                <span className="w-6 h-6 bg-indigo-500/15 rounded-lg flex items-center justify-center text-xs font-bold text-indigo-400">2</span>
                Vorschau & Export
              </h2>
              <p className="text-xs text-zinc-500">
                {status === 'generating'
                  ? `Rendering... ${currentItemIndex !== null ? `Bild ${currentItemIndex + 1}/${items.length}` : ''}`
                  : status === 'done'
                    ? 'Video bereit'
                    : `${items.length} Medien bereit`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {status === 'generating' && (
                <button
                  onClick={() => cancelGenerationRef.current?.()}
                  className="px-4 py-2.5 rounded-xl font-medium flex items-center gap-2 transition-all text-sm bg-red-600/15 text-red-400 hover:bg-red-600/25 border border-red-500/30 active:scale-[0.97]"
                >
                  <StopCircle className="w-4 h-4" />
                  Abbrechen
                </button>
              )}
              <button
                onClick={generateVideo}
                disabled={items.length === 0 || status === 'generating'}
                className={`px-5 py-2.5 rounded-xl font-medium flex items-center gap-2 transition-all text-sm ${
                  status === 'generating'
                    ? 'bg-zinc-800 text-zinc-400 cursor-wait'
                    : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/30 active:scale-[0.97] disabled:bg-zinc-800 disabled:text-zinc-600 disabled:shadow-none'
                }`}
              >
                {status === 'generating' ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span className="font-mono tabular-nums">{Math.round(progress)}%</span>
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" />
                    Video erstellen
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Generation progress bar */}
          <AnimatePresence>
            {status === 'generating' && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="space-y-2"
              >
                <div className="h-2 bg-zinc-800/80 rounded-full overflow-hidden">
                  <div
                    className="h-full progress-shimmer rounded-full transition-all duration-150 ease-linear"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-zinc-500">
                    {currentItemIndex !== null ? `Bild ${currentItemIndex + 1} von ${items.length}` : 'Starte...'}
                  </span>
                  {estimatedTimeRemaining !== null && (
                    <span className="text-zinc-500 font-mono tabular-nums">
                      ~{estimatedTimeRemaining}s verbleibend
                    </span>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className={`bg-zinc-900/50 border border-zinc-800/60 rounded-2xl overflow-hidden relative flex items-center justify-center ${
            orientation === 'landscape' || orientation === 'classic'
              ? 'aspect-video'
              : orientation === 'square'
                ? 'aspect-square max-h-[60vh] mx-auto'
                : 'aspect-[9/16] max-h-[65vh] mx-auto'
          }`}>
            {items.length === 0 ? (
              <div className="text-center text-zinc-600 flex flex-col items-center p-8">
                <div className="w-16 h-16 bg-zinc-800/50 rounded-2xl flex items-center justify-center mb-4">
                  <ImageIcon className="w-8 h-8 opacity-30" />
                </div>
                <p className="text-sm font-medium text-zinc-500">Keine Medien vorhanden</p>
                <p className="text-xs text-zinc-600 mt-1">Lade Bilder oder Videos hoch</p>
              </div>
            ) : (
              <>
                <canvas
                  ref={canvasRef}
                  className={`w-full h-full object-contain bg-black transition-opacity duration-300 ${status === 'idle' ? 'opacity-0 absolute inset-0 pointer-events-none' : 'opacity-100 relative z-10'}`}
                />

                {status === 'idle' && (
                  <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/80 z-20">
                    {/* Thumbnail mosaic background */}
                    <div className="absolute inset-0 grid grid-cols-3 gap-0.5 opacity-15 overflow-hidden">
                      {items.slice(0, 9).map((item, idx) => (
                        <div key={item.id} className="w-full h-full overflow-hidden">
                          {item.type === 'image' ? (
                            <img src={item.url} className="w-full h-full object-cover" alt="" />
                          ) : (
                            <video src={item.url} className="w-full h-full object-cover" muted />
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="relative text-center z-10">
                      <button
                        onClick={generateVideo}
                        className="bg-white/95 text-zinc-950 hover:bg-white px-7 py-3 rounded-2xl font-semibold flex items-center gap-2.5 transition-all shadow-2xl shadow-black/30 active:scale-[0.97] mx-auto text-sm"
                      >
                        <Play className="w-5 h-5" />
                        Video erstellen
                      </button>
                      <p className="text-zinc-400 mt-3 text-xs">{items.length} Medien bereit</p>
                    </div>
                  </div>
                )}

                {status === 'generating' && (
                  <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-800/80 z-20">
                    <div
                      className="h-full progress-shimmer rounded-r-full transition-all duration-75 ease-linear"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                )}
              </>
            )}
          </div>

          {/* Done state: video player + download */}
          <AnimatePresence>
            {status === 'done' && videoUrl && (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-4"
              >
                {/* Video player */}
                <div className="bg-zinc-900/50 border border-zinc-800/60 rounded-2xl overflow-hidden">
                  <video
                    src={videoUrl}
                    controls
                    className="w-full"
                    style={{ maxHeight: '50vh' }}
                  />
                </div>

                <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div>
                    <h3 className="text-emerald-400 font-semibold text-sm mb-0.5 flex items-center gap-2">
                      <Check className="w-4 h-4" /> Video erstellt
                    </h3>
                    <p className="text-xs text-emerald-400/60">Bereit zum Herunterladen oder Teilen.</p>
                  </div>
                  <a
                    href={videoUrl}
                    download={`${projectTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'ken_burns_video'}.${getFileExtension()}`}
                    className="bg-emerald-500 hover:bg-emerald-400 text-zinc-950 px-5 py-2.5 rounded-xl font-medium flex items-center gap-2 transition-all text-sm shadow-lg shadow-emerald-500/20 active:scale-[0.97] whitespace-nowrap"
                  >
                    <Download className="w-4 h-4" />
                    Download .{getFileExtension()}
                  </a>
                </div>

                {exportFormat === 'mp4' && !actualMimeType.includes('mp4') && (
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex gap-3">
                    <div className="w-9 h-9 bg-amber-500/20 rounded-lg flex items-center justify-center shrink-0">
                      <Settings className="w-4 h-4 text-amber-500" />
                    </div>
                    <div className="text-xs">
                      <p className="text-amber-400 font-medium mb-0.5">WhatsApp-Kompatibilität</p>
                      <p className="text-amber-400/60 leading-relaxed">
                        Dein Browser unterstützt kein natives MP4-Encoding. Das Video wurde als WebM erstellt.
                        Sende es ggf. als <strong>"Dokument"</strong> in WhatsApp.
                      </p>
                    </div>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

      </main>

      {/* Editor Modal Overlay */}
      <AnimatePresence>
        {editingItem && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 lg:p-8">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
              onClick={() => setEditingId(null)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
              className="relative w-full max-w-5xl max-h-[90vh] overflow-y-auto bg-zinc-900 border border-zinc-800/80 rounded-3xl shadow-2xl custom-scrollbar"
            >
              <div className="sticky top-0 z-10 bg-zinc-900/95 backdrop-blur-xl border-b border-zinc-800/50 px-6 py-3.5 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 bg-indigo-500/15 rounded-lg flex items-center justify-center">
                    <Crop className="w-3.5 h-3.5 text-indigo-400" />
                  </div>
                  <h3 className="font-semibold text-base">Bearbeiten</h3>
                </div>
                <button
                  onClick={() => setEditingId(null)}
                  className="p-2 hover:bg-zinc-800 rounded-xl transition-colors text-zinc-400 hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-6">
                <ImageEditor
                  key={editingItem.id}
                  item={editingItem}
                  projectTitle={projectTitle}
                  orientation={orientation}
                  customWidth={customWidth}
                  customHeight={customHeight}
                  onSave={handleSaveEdit}
                  onCancel={() => setEditingId(null)}
                />
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Project Manager Modal */}
      <AnimatePresence>
        {isProjectManagerOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 lg:p-8">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
              onClick={() => setIsProjectManagerOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
              className="relative w-full max-w-2xl bg-zinc-900 border border-zinc-800/80 rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="px-6 py-3.5 border-b border-zinc-800/50 flex items-center justify-between bg-zinc-900/95 backdrop-blur-xl">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 bg-indigo-500/15 rounded-lg flex items-center justify-center">
                    <FolderOpen className="w-3.5 h-3.5 text-indigo-400" />
                  </div>
                  <h3 className="font-semibold text-base">Projekte</h3>
                </div>
                <button
                  onClick={() => setIsProjectManagerOpen(false)}
                  className="p-2 hover:bg-zinc-800 rounded-xl transition-colors text-zinc-400 hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-5 max-h-[60vh] overflow-y-auto custom-scrollbar">
                {!savedProjects || savedProjects.length === 0 ? (
                  <div className="text-center py-12">
                    <div className="w-14 h-14 bg-zinc-800/50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                      <FolderOpen className="w-7 h-7 text-zinc-600" />
                    </div>
                    <p className="text-sm text-zinc-500">Keine Projekte vorhanden</p>
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {savedProjects.map(project => (
                      <div
                        key={project.id}
                        className="flex items-center justify-between p-3.5 bg-zinc-800/30 border border-zinc-800/50 rounded-xl hover:border-indigo-500/30 hover:bg-zinc-800/50 transition-all group cursor-pointer"
                        onClick={() => loadProject(project)}
                      >
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium text-sm text-zinc-200 truncate group-hover:text-indigo-400 transition-colors">
                            {project.title}
                          </h4>
                          <p className="text-[11px] text-zinc-600 mt-0.5">
                            {new Date(project.updatedAt).toLocaleDateString()} · {project.items.length} Medien
                          </p>
                        </div>
                        <div className="flex items-center gap-1 ml-3 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => { e.stopPropagation(); project.id && deleteProject(project.id); }}
                            className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                            title="Löschen"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Project Settings Modal (Anytime access) */}
      <AnimatePresence>
        {isSetup && items.length > 0 && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 lg:p-8">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
              onClick={() => setIsSetup(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
              className="relative w-full max-w-xl bg-zinc-900 border border-zinc-800/80 rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="px-6 py-3.5 border-b border-zinc-800/50 flex items-center justify-between bg-zinc-900/95 backdrop-blur-xl">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 bg-indigo-500/15 rounded-lg flex items-center justify-center">
                    <Settings className="w-3.5 h-3.5 text-indigo-400" />
                  </div>
                  <h3 className="font-semibold text-base">Einstellungen</h3>
                </div>
                <button
                  onClick={() => setIsSetup(false)}
                  className="p-2 hover:bg-zinc-800 rounded-xl transition-colors text-zinc-400 hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            <div className="p-8 max-h-[80vh] overflow-y-auto custom-scrollbar space-y-6">
              <div className="space-y-2">
                <label className="text-sm font-medium text-zinc-300">Projekt-Titel</label>
                <input 
                  type="text" 
                  value={projectTitle}
                  onChange={e => setProjectTitle(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-shadow"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-zinc-300">Format</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <button
                    onClick={() => setOrientation('landscape')}
                    className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${orientation === 'landscape' ? 'bg-indigo-500/10 border-indigo-500 text-indigo-400' : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700'}`}
                  >
                    <Monitor className="w-6 h-6" />
                    <div className="text-center">
                      <p className="text-xs font-medium">Querformat</p>
                      <p className="text-[10px] opacity-60">16:9</p>
                    </div>
                  </button>
                  <button
                    onClick={() => setOrientation('portrait')}
                    className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${orientation === 'portrait' ? 'bg-indigo-500/10 border-indigo-500 text-indigo-400' : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700'}`}
                  >
                    <Smartphone className="w-6 h-6" />
                    <div className="text-center">
                      <p className="text-xs font-medium">Hochformat</p>
                      <p className="text-[10px] opacity-60">9:16</p>
                    </div>
                  </button>
                  <button
                    onClick={() => setOrientation('instagram')}
                    className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${orientation === 'instagram' ? 'bg-indigo-500/10 border-indigo-500 text-indigo-400' : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700'}`}
                  >
                    <Instagram className="w-6 h-6" />
                    <div className="text-center">
                      <p className="text-xs font-medium">Instagram</p>
                      <p className="text-[10px] opacity-60">4:5</p>
                    </div>
                  </button>
                  <button
                    onClick={() => setOrientation('square')}
                    className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${orientation === 'square' ? 'bg-indigo-500/10 border-indigo-500 text-indigo-400' : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700'}`}
                  >
                    <Square className="w-6 h-6" />
                    <div className="text-center">
                      <p className="text-xs font-medium">Quadrat</p>
                      <p className="text-[10px] opacity-60">1:1</p>
                    </div>
                  </button>
                  <button
                    onClick={() => setOrientation('custom')}
                    className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${orientation === 'custom' ? 'bg-indigo-500/10 border-indigo-500 text-indigo-400' : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700'}`}
                  >
                    <Settings className="w-6 h-6" />
                    <div className="text-center">
                      <p className="text-xs font-medium">Eigene Maße</p>
                    </div>
                  </button>
                </div>
              </div>

              {orientation === 'custom' && (
                <div className="grid grid-cols-2 gap-4 p-4 bg-zinc-950 border border-zinc-800 rounded-2xl">
                  <div className="space-y-1.5">
                    <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">Breite (px)</label>
                    <input 
                      type="number" 
                      value={customWidth}
                      onChange={e => setCustomWidth(Math.max(1, Number(e.target.value)))}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">Höhe (px)</label>
                    <input 
                      type="number" 
                      value={customHeight}
                      onChange={e => setCustomHeight(Math.max(1, Number(e.target.value)))}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-zinc-300">Standard-Dauer</label>
                  <div className="relative">
                    <input 
                      type="number" 
                      min="1" 
                      max="30" 
                      step="0.5"
                      value={defaultDuration}
                      onChange={e => setDefaultDuration(Number(e.target.value))}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 text-sm">Sek.</span>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-zinc-300">Export-Format</label>
                  <div className="flex bg-zinc-950 border border-zinc-800 rounded-xl p-1">
                    <button
                      onClick={() => setExportFormat('mp4')}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${exportFormat === 'mp4' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
                    >
                      MP4
                    </button>
                    <button
                      onClick={() => setExportFormat('webm')}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${exportFormat === 'webm' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
                    >
                      WebM
                    </button>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-zinc-300">Hintergrundmusik</label>
                <div className="flex items-center gap-3">
                  <label className="flex-1 bg-zinc-950 border border-zinc-800 hover:border-indigo-500/50 rounded-xl px-4 py-3 text-zinc-400 cursor-pointer transition-colors flex items-center justify-between">
                    <span className="truncate">{audioFile ? audioFile.name : 'Audiodatei auswählen...'}</span>
                    <Music className="w-5 h-5 text-zinc-500" />
                    <input type="file" accept="audio/*" className="hidden" onChange={handleAudioUpload} />
                  </label>
                  {audioFile && (
                    <button
                      onClick={toggleAudioPreview}
                      className={`p-3 bg-zinc-950 border rounded-xl transition-colors ${isAudioPlaying ? 'border-indigo-500 text-indigo-400 bg-indigo-500/10' : 'border-zinc-800 hover:border-indigo-500/50 hover:text-indigo-400 text-zinc-500'}`}
                      title={isAudioPlaying ? 'Stoppen' : 'Anhören'}
                    >
                      {isAudioPlaying ? <Pause className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                    </button>
                  )}
                  {audioFile && (
                    <button
                      onClick={removeAudio}
                      className="p-3 bg-zinc-950 border border-zinc-800 hover:bg-red-500/10 hover:border-red-500/50 hover:text-red-500 rounded-xl transition-colors text-zinc-500"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  )}
                </div>
              </div>

              <div className="space-y-2 pt-2">
                <label className="flex items-center gap-3 cursor-pointer">
                  <div className="relative flex items-center">
                    <input 
                      type="checkbox" 
                      checked={showTitleOverlay}
                      onChange={e => setShowTitleOverlay(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-zinc-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-500"></div>
                  </div>
                  <span className="text-sm font-medium text-zinc-300">Titel im Video einblenden</span>
                </label>
              </div>
            </div>
              <div className="p-5 border-t border-zinc-800/50 bg-zinc-900/50 flex justify-end">
                <button
                  onClick={() => setIsSetup(false)}
                  className="px-7 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-medium transition-all shadow-lg shadow-indigo-500/20 active:scale-[0.97] text-sm"
                >
                  Fertig
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Google Photos Loading/Error Overlay */}
      <AnimatePresence>
        {googlePhotosLoading && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="relative bg-zinc-900 border border-zinc-800/80 rounded-3xl shadow-2xl p-8 flex flex-col items-center gap-4"
            >
              <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
              <p className="text-sm text-zinc-400">Fotos werden importiert...</p>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Google Photos Error Toast */}
      <AnimatePresence>
        {googlePhotosError && !googlePhotosLoading && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-sm text-red-400 flex items-start gap-3 max-w-[90vw] max-h-[50vh] overflow-auto"
          >
            <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{googlePhotosError}</span>
            <button onClick={() => setGooglePhotosError(null)} className="text-red-300 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
