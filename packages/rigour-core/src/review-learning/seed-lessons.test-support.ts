/**
 * Tests only: writes a fresh review lessons store. Refuses when one exists, so it can never overwrite a store; a
 * change to an existing store goes through updateLessons or writeLessons(cwd, lessons, read).
 */
import fs from 'fs';
import path from 'path';
import { lessonsPath, type ReviewLesson } from './lessons.js';

export function seedLessons(cwd: string, lessons: ReviewLesson[]): void {
    const file = lessonsPath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, lessons }, null, 2) + '\n', { flag: 'wx' });
}
