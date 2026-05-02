import { useEffect, useState } from "react";

export function useOnlineStatus() {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const setOnlineStatus = () => setOnline(true);
    const setOfflineStatus = () => setOnline(false);
    window.addEventListener("online", setOnlineStatus);
    window.addEventListener("offline", setOfflineStatus);
    return () => {
      window.removeEventListener("online", setOnlineStatus);
      window.removeEventListener("offline", setOfflineStatus);
    };
  }, []);

  return online;
}
