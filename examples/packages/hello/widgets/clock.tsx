import { useEffect, useState } from 'react';

/**
 * Виджет пакета: лежит в `widgets/` пакета и адресуется голым `clock`, как
 * виджет свободного каталога `.stepcast/widgets/`. Витрина только читает его;
 * пакет правится на диске.
 */
export default function Clock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return <p>{now.toLocaleTimeString()}</p>;
}
