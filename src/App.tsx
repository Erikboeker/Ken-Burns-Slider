import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Upload, Play, Download, Trash2, Image as ImageIcon, Film, Loader2, ZoomIn, ZoomOut, Check, Crop, X, Settings, Smartphone, Monitor, Music, PlusCircle, GripVertical, Square, Instagram, Save, FolderOpen } from 'lucide-react';
import { db, type Project } from './services/storage';
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
        customTitle: useDefaultTitle ? undefined : customTitle
      });
    }, 100);
    return () => clearTimeout(timer);
  }, [rect, mode, duration, trimStart, trimEnd, useDefaultTitle, customTitle, onSave, isVideo]);

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
      // Reset to maximized frame for Pan mode
      let w, h;
      if (frameAspect > imgAspect) {
        w = 1;
        h = imgAspect / frameAspect;
      } else {
        h = 1;
        w = frameAspect / imgAspect;
      }
      const x = (1 - w) / 2;
      const y = (1 - h) / 2;
      setRect({ x, y, w, h });
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
                  <Monitor className="w-4 h-4" /> Kamerafahrt
                </button>
              </div>
            </div>
          )}
        </div>
        

        
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
              <div 
                className="absolute border-2 border-indigo-500 shadow-[0_0_0_9999px_rgba(0,0,0,0.6)] cursor-move touch-none group"
                style={{
                  left: `${rect.x * 100}%`,
                  top: `${rect.y * 100}%`,
                  width: `${rect.w * 100}%`,
                  height: `${rect.h * 100}%`,
                }}
                onPointerDown={handlePointerDown}
              >
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
                <div 
                  className="absolute -top-1.5 -left-1.5 w-4 h-4 bg-white border-2 border-indigo-500 rounded-full cursor-nwse-resize z-10 shadow-sm hover:scale-125 transition-transform"
                  onPointerDown={(e) => handlePointerDown(e, 'top-left')}
                ></div>
                <div 
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-white border-2 border-indigo-500 rounded-full cursor-nesw-resize z-10 shadow-sm hover:scale-125 transition-transform"
                  onPointerDown={(e) => handlePointerDown(e, 'top-right')}
                ></div>
                <div 
                  className="absolute -bottom-1.5 -left-1.5 w-4 h-4 bg-white border-2 border-indigo-500 rounded-full cursor-nesw-resize z-10 shadow-sm hover:scale-125 transition-transform"
                  onPointerDown={(e) => handlePointerDown(e, 'bottom-left')}
                ></div>
                <div 
                  className="absolute -bottom-1.5 -right-1.5 w-4 h-4 bg-white border-2 border-indigo-500 rounded-full cursor-nwse-resize z-10 shadow-sm hover:scale-125 transition-transform"
                  onPointerDown={(e) => handlePointerDown(e, 'bottom-right')}
                ></div>
              </div>
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
      className={`flex items-center gap-3 p-2 bg-zinc-900/50 border rounded-xl group transition-all ${isDragging ? 'border-indigo-500 bg-zinc-800 shadow-2xl z-50 scale-[1.02] opacity-50' : editingId === item.id ? 'border-indigo-500/50 bg-indigo-500/5' : 'border-zinc-800 hover:border-zinc-700'}`}
    >
      <div 
        {...attributes}
        {...listeners}
        className="p-1 text-zinc-600 hover:text-zinc-400 cursor-grab active:cursor-grabbing touch-none"
      >
        <GripVertical className="w-4 h-4" />
      </div>

      <div 
        className="relative w-16 h-16 rounded-lg overflow-hidden bg-zinc-950 flex-shrink-0 cursor-pointer"
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
        <div className="absolute top-1 left-1 p-0.5 bg-black/60 backdrop-blur-md rounded text-[8px] font-medium text-white">
          {item.type === 'video' ? <Film className="w-2 h-2" /> : <ImageIcon className="w-2 h-2" />}
        </div>
      </div>

      <div 
        className="flex-1 min-w-0 cursor-pointer"
        onClick={() => setEditingId(item.id)}
      >
        <p className="text-sm font-medium truncate text-zinc-200">
          {item.customTitle || `Medium ${i + 1}`}
        </p>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[10px] font-mono text-zinc-500">
            {item.type === 'video' 
              ? `${Math.round(item.trimEnd - item.trimStart)}s` 
              : `${Math.round(item.duration / 1000)}s`}
          </span>
          <span className="text-[10px] text-zinc-600 uppercase tracking-tighter bg-zinc-950 px-1 rounded">
            {item.type === 'video' 
              ? 'Video' 
              : item.mode === 'zoom-in' 
                ? 'Reinzoomen' 
                : item.mode === 'zoom-out' 
                  ? 'Rauszoomen' 
                  : 'Kamerafahrt'}
          </span>
        </div>
        {isActive && isGenerating && (
          <div className="mt-2 h-1 bg-zinc-800 rounded-full overflow-hidden">
            <div 
              className="h-full bg-indigo-500 transition-all duration-75 ease-linear"
              style={{ width: `${currentProgress}%` }}
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-1">
        <button 
          onClick={() => setEditingId(item.id)}
          className={`p-2 rounded-lg transition-colors ${editingId === item.id ? 'text-indigo-400 bg-indigo-500/10' : 'text-zinc-500 hover:text-white hover:bg-zinc-800'}`}
          title="Bearbeiten"
        >
          <Crop className="w-4 h-4" />
        </button>
        <button 
          onClick={() => removeItem(item.id)}
          className="p-2 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
          title="Löschen"
        >
          <Trash2 className="w-4 h-4" />
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
  
  const savedProjects = useLiveQuery(() => db.projects.toArray());
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    setAudioFile(null);
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
  }, [audioUrl]);

  const handleFiles = useCallback(async (newFiles: File[]) => {
    const validFiles = newFiles.filter(f => f.type.startsWith('image/') || f.type.startsWith('video/'));
    if (validFiles.length === 0) return;

    const loadedItems = await Promise.all(
      validFiles.map(async (file) => {
        const url = URL.createObjectURL(file);
        const isVideo = file.type.startsWith('video/');
        
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
          await new Promise((resolve) => {
            let timeout = setTimeout(() => resolve(null), 5000);
            const checkReady = () => {
              if (width > 0) return;
              if ((element as HTMLVideoElement).videoWidth > 0) {
                clearTimeout(timeout);
                width = (element as HTMLVideoElement).videoWidth;
                height = (element as HTMLVideoElement).videoHeight;
                itemDuration = (element as HTMLVideoElement).duration * 1000;
                if (!itemDuration || !isFinite(itemDuration)) itemDuration = defaultDuration * 1000;
                resolve(null);
              }
            };
            element.addEventListener('loadedmetadata', checkReady);
            element.addEventListener('loadeddata', checkReady);
            element.addEventListener('canplay', checkReady);
            element.onerror = (e) => {
              clearTimeout(timeout);
              console.error("Video load error", e);
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

        if (orientation === 'portrait' && mediaAspect > 1) {
          // Video is portrait, image is landscape -> pan left to right
          h = 1;
          w = h * currentFrameAspect / mediaAspect;
          x = 0; // Start at left
          y = 0;
        } else if (orientation === 'landscape' && mediaAspect < 1) {
          // Video is landscape, image is portrait -> pan top to bottom
          w = 1;
          h = w * mediaAspect / currentFrameAspect;
          x = 0;
          y = 0; // Start at top
        } else {
          // Default zoom-in behavior
          const maxW = Math.min(1, currentFrameAspect / mediaAspect);
          w = 0.6 * maxW;
          h = w * mediaAspect / currentFrameAspect;
          x = (1 - w) / 2;
          y = (1 - h) / 2;
        }

        const color = getDominantColor(element);

        return {
          id: Math.random().toString(36).substring(2, 9),
          type: isVideo ? 'video' : 'image',
          file,
          url,
          element,
          rect: { x, y, w, h },
          mode: ((orientation === 'portrait' && mediaAspect > 1) || (orientation === 'landscape' && mediaAspect < 1) ? 'pan' : 'zoom-in') as KenBurnsMode,
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

      const draw = (timestamp: number) => {
        try {
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
              currentScale = Math.min(canvas.width / mediaWidth, canvas.height / mediaHeight);
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
              currentScale = targetScale;
              if (orientation === 'portrait' && mediaWidth / mediaHeight > 1) {
                const startDx = 0; 
                const endDx = canvas.width - mediaWidth * targetScale; 
                currentDx = startDx + (endDx - startDx) * easeT;
                currentDy = targetDy; 
              } else if (orientation === 'landscape' && mediaWidth / mediaHeight < 1) {
                const startDy = 0; 
                const endDy = canvas.height - mediaHeight * targetScale; 
                currentDx = targetDx; 
                currentDy = startDy + (endDy - startDy) * easeT;
              } else {
                currentScale = baseScale + (targetScale - baseScale) * easeT;
                currentDx = baseDx + (targetDx - baseDx) * easeT;
                currentDy = baseDy + (targetDy - baseDy) * easeT;
              }
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
          originalDuration: item.originalDuration
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
      <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans flex items-center justify-center p-6 selection:bg-indigo-500/30">
        <div className="w-full max-w-xl bg-zinc-900/80 backdrop-blur-xl border border-zinc-800 rounded-3xl p-8 shadow-2xl">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-12 h-12 bg-indigo-500/20 rounded-2xl flex items-center justify-center">
              <Film className="w-6 h-6 text-indigo-400" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Neues Projekt</h1>
              <p className="text-zinc-400">Richte dein Ken Burns Video ein.</p>
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

            <div className="mt-8">
              <button
                onClick={() => setIsSetup(false)}
                className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-4 rounded-2xl transition-all shadow-lg shadow-indigo-500/20 active:scale-[0.98]"
              >
                Projekt starten
              </button>
            </div>
            <div className="flex justify-center gap-4 mt-4">
              <button 
                onClick={() => setIsProjectManagerOpen(true)}
                className="text-sm text-zinc-500 hover:text-indigo-400 flex items-center gap-2 transition-colors"
              >
                <FolderOpen className="w-4 h-4" /> Vorhandenes Projekt laden
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-indigo-500/30">
      <header className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Film className="w-6 h-6 text-indigo-400" />
            <h1 className="text-xl font-semibold tracking-tight">{projectTitle || 'Ken Burns Studio'}</h1>
          </div>
          <div className="flex items-center gap-4">
            <button 
              onClick={saveProject}
              disabled={isSaving || items.length === 0}
              className="text-sm text-zinc-400 hover:text-indigo-400 flex items-center gap-2 transition-colors disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Speichern
            </button>
            <button 
              onClick={() => setIsProjectManagerOpen(true)}
              className="text-sm text-zinc-400 hover:text-indigo-400 flex items-center gap-2 transition-colors"
            >
              <FolderOpen className="w-4 h-4" /> Projekte laden
            </button>
            <button 
              onClick={resetProject}
              className="text-sm text-zinc-400 hover:text-red-400 flex items-center gap-2 transition-colors"
            >
              <PlusCircle className="w-4 h-4" /> Neues Projekt
            </button>
            <button 
              onClick={() => setIsSetup(true)}
              className="text-sm text-zinc-400 hover:text-white flex items-center gap-2 transition-colors"
            >
              <Settings className="w-4 h-4" /> Projekteinstellungen
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Left Column: Upload & List */}
        <div className="lg:col-span-4 space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <h2 className="text-lg font-medium">1. Medien verwalten</h2>
              <p className="text-sm text-zinc-400">{items.length} Elemente in der Liste.</p>
            </div>
            {items.length > 0 && (
              <button 
                onClick={clearAllItems}
                className="text-xs text-zinc-500 hover:text-red-400 flex items-center gap-1 transition-colors"
              >
                <Trash2 className="w-3 h-3" /> Alle löschen
              </button>
            )}
          </div>

          <div 
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-zinc-800 hover:border-indigo-500/50 hover:bg-indigo-500/5 transition-colors rounded-2xl p-8 text-center cursor-pointer group"
          >
            <input 
              type="file" 
              multiple 
              accept="image/*,video/*" 
              className="hidden" 
              ref={fileInputRef}
              onChange={(e) => handleFiles(Array.from(e.target.files || []))}
            />
            <div className="w-12 h-12 bg-zinc-900 rounded-full flex items-center justify-center mx-auto mb-4 group-hover:scale-110 transition-transform">
              <Upload className="w-6 h-6 text-zinc-400 group-hover:text-indigo-400" />
            </div>
            <p className="font-medium mb-1">Klicken oder Medien hier ablegen</p>
            <p className="text-xs text-zinc-500">Unterstützt Bilder & Videos</p>
          </div>

          {items.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wider">Ausgewählte Medien ({items.length})</h3>
                <p className="text-[10px] text-zinc-600">Drag & Drop zum Sortieren</p>
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
                  <div className="space-y-2">
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
        <div className="lg:col-span-8 space-y-6 lg:sticky lg:top-24 lg:h-fit">
          <div className="space-y-2 flex items-end justify-between">
            <div>
              <h2 className="text-lg font-medium">2. Video generieren</h2>
              <p className="text-sm text-zinc-400">Vorschau und Export deines Ken Burns Videos.</p>
            </div>
            <button
              onClick={generateVideo}
              disabled={items.length === 0 || status === 'generating'}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white px-6 py-2.5 rounded-xl font-medium flex items-center gap-2 transition-colors"
            >
              {status === 'generating' ? (
                <div className="flex items-center gap-2">
                   <Loader2 className="w-4 h-4 animate-spin" />
                   <span className="text-xs font-mono text-zinc-400">
                     {Math.round(progress)}%
                   </span>
                </div>
              ) : (
                <Play className="w-4 h-4" />
              )}
              {status === 'generating' ? 'Erstelle...' : 'Video Erstellen'}
            </button>
          </div>

          {status === 'generating' && estimatedTimeRemaining !== null && (
            <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-xl p-3 flex items-center justify-between animate-in fade-in slide-in-from-top-2">
              <div className="flex items-center gap-2 text-indigo-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm font-medium">Video wird gerendert...</span>
              </div>
              <div className="text-sm text-indigo-400/80 font-mono">
                Noch ca. {estimatedTimeRemaining}s
              </div>
            </div>
          )}

          <div className={`bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden relative flex items-center justify-center ${orientation === 'landscape' ? 'aspect-video' : 'aspect-[9/16] max-h-[70vh] mx-auto'}`}>
            {items.length === 0 ? (
              <div className="text-center text-zinc-500 flex flex-col items-center">
                <ImageIcon className="w-12 h-12 mb-3 opacity-20" />
                <p>Lade zuerst Bilder hoch</p>
              </div>
            ) : (
              <>
                <canvas 
                  ref={canvasRef} 
                  className={`w-full h-full object-contain bg-black ${status === 'idle' ? 'opacity-0 absolute inset-0 pointer-events-none' : 'opacity-100 relative z-10'}`}
                />
                
                {status === 'idle' && (
                  <div className="absolute inset-0 flex items-center justify-center bg-zinc-900 z-20">
                    <div className="text-center">
                      <p className="text-zinc-400 mb-4">Bereit zur Generierung</p>
                      <button
                        onClick={generateVideo}
                        className="bg-white text-black hover:bg-zinc-200 px-6 py-2.5 rounded-xl font-medium flex items-center gap-2 transition-colors mx-auto"
                      >
                        <Play className="w-4 h-4" />
                        Starten
                      </button>
                    </div>
                  </div>
                )}

                {status === 'generating' && (
                  <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-zinc-800 z-20">
                    <div 
                      className="h-full bg-indigo-500 transition-all duration-75 ease-linear"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                )}
              </>
            )}
          </div>

          {status === 'done' && videoUrl && (
            <div className="space-y-4">
              <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-6 flex items-center justify-between">
                <div>
                  <h3 className="text-emerald-400 font-medium mb-1">Video erfolgreich erstellt!</h3>
                  <p className="text-sm text-emerald-400/70">Du kannst das Video nun herunterladen oder direkt ansehen.</p>
                </div>
                <a 
                  href={videoUrl} 
                  download={`${projectTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'ken_burns_video'}.${getFileExtension()}`}
                  className="bg-emerald-500 hover:bg-emerald-400 text-zinc-950 px-5 py-2.5 rounded-xl font-medium flex items-center gap-2 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Herunterladen (.{getFileExtension()})
                </a>
              </div>
              
              {exportFormat === 'mp4' && !actualMimeType.includes('mp4') && (
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex gap-3">
                  <div className="w-10 h-10 bg-amber-500/20 rounded-lg flex items-center justify-center shrink-0">
                    <Settings className="w-5 h-5 text-amber-500" />
                  </div>
                  <div className="text-sm">
                    <p className="text-amber-400 font-medium mb-1">WhatsApp-Kompatibilität</p>
                    <p className="text-amber-400/70 leading-relaxed">
                      Dein Browser unterstützt kein natives MP4-Encoding. Das Video wurde als WebM erstellt und in .mp4 umbenannt. 
                      Falls WhatsApp den Ton nicht abspielt, sende das Video bitte als <strong>"Dokument"</strong> statt als Video.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

      </main>

      {/* Editor Modal Overlay */}
      {editingItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 lg:p-8">
          <div 
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            onClick={() => setEditingId(null)}
          />
          <div className="relative w-full max-w-5xl max-h-[90vh] overflow-y-auto bg-zinc-900 border border-zinc-800 rounded-3xl shadow-2xl custom-scrollbar">
            <div className="sticky top-0 z-10 bg-zinc-900/90 backdrop-blur-md border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-indigo-500/20 rounded-lg flex items-center justify-center">
                  <Crop className="w-4 h-4 text-indigo-400" />
                </div>
                <h3 className="font-semibold text-lg">Eigenschaften bearbeiten</h3>
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
          </div>
        </div>
      )}

      {/* Project Manager Modal */}
      {isProjectManagerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 lg:p-8">
          <div 
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            onClick={() => setIsProjectManagerOpen(false)}
          />
          <div className="relative w-full max-w-2xl bg-zinc-900 border border-zinc-800 rounded-3xl shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/90 backdrop-blur-md">
              <div className="flex items-center gap-3">
                <FolderOpen className="w-5 h-5 text-indigo-400" />
                <h3 className="font-semibold text-lg">Gespeicherte Projekte</h3>
              </div>
              <button 
                onClick={() => setIsProjectManagerOpen(false)}
                className="p-2 hover:bg-zinc-800 rounded-xl transition-colors text-zinc-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 max-h-[60vh] overflow-y-auto custom-scrollbar">
              {!savedProjects || savedProjects.length === 0 ? (
                <div className="text-center py-12">
                  <FolderOpen className="w-12 h-12 text-zinc-700 mx-auto mb-4" />
                  <p className="text-zinc-500">Keine gespeicherten Projekte gefunden.</p>
                </div>
              ) : (
                <div className="grid gap-3">
                  {savedProjects.map(project => (
                    <div 
                      key={project.id}
                      className="flex items-center justify-between p-4 bg-zinc-800/50 border border-zinc-700/50 rounded-2xl hover:border-indigo-500/50 transition-all group"
                    >
                      <div className="flex-1 min-w-0 cursor-pointer" onClick={() => loadProject(project)}>
                        <h4 className="font-medium text-zinc-100 truncate group-hover:text-indigo-400 transition-colors">
                          {project.title}
                        </h4>
                        <p className="text-xs text-zinc-500 mt-1">
                          Zuletzt bearbeitet: {new Date(project.updatedAt).toLocaleString()} • {project.items.length} Medien
                        </p>
                      </div>
                      <div className="flex items-center gap-2 ml-4">
                        <button 
                          onClick={() => loadProject(project)}
                          className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-700 rounded-lg transition-colors"
                          title="Laden"
                        >
                          <FolderOpen className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => project.id && deleteProject(project.id)}
                          className="p-2 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                          title="Löschen"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="p-6 border-t border-zinc-800 bg-zinc-900/50 flex justify-end">
              <button 
                onClick={() => setIsProjectManagerOpen(false)}
                className="px-6 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl font-medium transition-colors"
              >
                Schließen
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Project Settings Modal (Anytime access) */}
      {isSetup && items.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 lg:p-8">
          <div 
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            onClick={() => setIsSetup(false)}
          />
          <div className="relative w-full max-w-xl bg-zinc-900 border border-zinc-800 rounded-3xl shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/90 backdrop-blur-md">
              <div className="flex items-center gap-3">
                <Settings className="w-5 h-5 text-indigo-400" />
                <h3 className="font-semibold text-lg">Projekteinstellungen</h3>
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
            <div className="p-6 border-t border-zinc-800 bg-zinc-900/50 flex justify-end">
              <button 
                onClick={() => setIsSetup(false)}
                className="px-8 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-medium transition-colors shadow-lg shadow-indigo-500/20"
              >
                Fertig
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
