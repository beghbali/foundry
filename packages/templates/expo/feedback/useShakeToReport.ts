import { useEffect, useRef } from 'react';
import { Accelerometer } from 'expo-sensors';

const SHAKE_THRESHOLD = 1.8;
const SHAKE_COOLDOWN_MS = 2000;

/**
 * Calls `onShake` when the user shakes the device.
 * Requires `expo-sensors` to be installed.
 */
export function useShakeToReport(onShake: () => void) {
  const lastShake = useRef(0);

  useEffect(() => {
    Accelerometer.setUpdateInterval(100);

    const subscription = Accelerometer.addListener(({ x, y, z }) => {
      const magnitude = Math.sqrt(x * x + y * y + z * z);
      const now = Date.now();

      if (magnitude > SHAKE_THRESHOLD && now - lastShake.current > SHAKE_COOLDOWN_MS) {
        lastShake.current = now;
        onShake();
      }
    });

    return () => subscription.remove();
  }, [onShake]);
}
