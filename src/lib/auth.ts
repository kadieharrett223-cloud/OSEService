import { requireAccessUser, getCurrentAccessUser } from "@/lib/session";

export type CurrentUser = {
  id: string;
  fullName: string | null;
};

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const accessUser = await getCurrentAccessUser();
  if (!accessUser) return null;

  return {
    id: accessUser.id,
    fullName: accessUser.fullName,
  };
}

export async function requireUser() {
  const user = await requireAccessUser();
  return {
    id: user.id,
    fullName: user.fullName,
  };
}
