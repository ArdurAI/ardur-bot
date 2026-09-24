import type { Stats } from "node:fs";
export interface Win32FileHandle {
  fd: number;
  stat(): Promise<Stats>;
  truncate(length?: number): Promise<void>;
  writeFile(data: string | Uint8Array): Promise<void>;
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
}
interface Bindings {
  win32NtRelativeAvailable(): boolean;
  pathFromDirectoryFd(fd: number): string;
  openExistingChildViaDirectoryFdWin32(fd: number, name: string): Win32FileHandle;
  createExclusiveChildViaDirectoryFdWin32(fd: number, name: string): Win32FileHandle;
  mkdirChildViaDirectoryFdWin32(fd: number, name: string): string | undefined;
  openChildDirectoryViaDirectoryFdWin32(fd: number, name: string): Win32FileHandle;
}
let bindings: Bindings | undefined;
export function installWin32Bindings(value: Bindings) {
  bindings = value;
}
function required() {
  if (!bindings) throw new Error("Native directory handles unavailable.");
  return bindings;
}
export function win32NtRelativeAvailable() {
  return bindings?.win32NtRelativeAvailable() ?? false;
}
export function pathFromDirectoryFd(fd: number) {
  return required().pathFromDirectoryFd(fd);
}
export function openExistingChildViaDirectoryFdWin32(fd: number, name: string) {
  return required().openExistingChildViaDirectoryFdWin32(fd, name);
}
export function createExclusiveChildViaDirectoryFdWin32(fd: number, name: string) {
  return required().createExclusiveChildViaDirectoryFdWin32(fd, name);
}
export function mkdirChildViaDirectoryFdWin32(fd: number, name: string) {
  return required().mkdirChildViaDirectoryFdWin32(fd, name);
}
export function openChildDirectoryViaDirectoryFdWin32(fd: number, name: string) {
  return required().openChildDirectoryViaDirectoryFdWin32(fd, name);
}
