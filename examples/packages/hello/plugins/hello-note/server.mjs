// Каталожный плагин пакета: имя плагина равно имени каталога (hello-note).
export default {
  name: 'hello-note',
  version: '0.1.0',
  commands: [
    {
      name: 'hello-note',
      spec: { description: 'поздороваться из пакета hello' },
      run: (_args, io) => {
        io.out('привет из пакета hello');
        return 0;
      },
    },
  ],
};
