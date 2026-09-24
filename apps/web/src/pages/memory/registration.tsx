import { Brain } from "lucide-react";
import MemorySettings from "./MemorySettings";

export function memorySection(label: string) {
  return { id: "memory" as const, label, icon: Brain, page: <MemorySettings /> };
}
