// Состояние модуля в контексте его экрана.
import { createContext, useContext } from "react";
import type { ProfilesStore } from "./store.ts";

export const ProfilesCtx = createContext<ProfilesStore | null>(null);
export const useProfiles = (): ProfilesStore => useContext(ProfilesCtx)!;
