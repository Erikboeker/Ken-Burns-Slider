import Dexie, { type Table } from 'dexie';

export interface Project {
  id?: number;
  title: string;
  updatedAt: number;
  orientation: 'landscape' | 'portrait' | 'square' | 'instagram' | 'classic' | 'custom';
  customWidth: number;
  customHeight: number;
  defaultDuration: number;
  exportFormat: 'mp4' | 'webm';
  showTitleOverlay: boolean;
  musicVolumeDuringVideo?: number;
  audioFile?: File;
  items: {
    id: string;
    type: 'image' | 'video';
    file: File;
    rect: { x: number; y: number; w: number; h: number };
    mode: 'zoom-in' | 'zoom-out' | 'pan';
    duration: number;
    customTitle?: string;
    dominantColor: { r: number; g: number; b: number };
    trimStart: number;
    trimEnd: number;
    originalDuration: number;
    panStart?: { x: number; y: number; w: number; h: number };
    panEnd?: { x: number; y: number; w: number; h: number };
  }[];
}

export class MyDatabase extends Dexie {
  projects!: Table<Project>;

  constructor() {
    super('KenBurnsStudioDB');
    this.version(1).stores({
      projects: '++id, title, updatedAt'
    });
  }
}

export const db = new MyDatabase();
