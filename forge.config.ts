import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    asar: false,
    name: 'Orbiv',
    executableName: 'Orbiv',
    appBundleId: 'com.akintewe.orbiv',
    appCategoryType: 'public.app-category.productivity',
    icon: 'assets/icon',
    ignore: (path: string) => {
      if (path === '' || path === '/') return false;
      // Always include .vite build output
      if (path.startsWith('/.vite')) return false;
      // Include node_modules but strip dev-only packages
      if (path.startsWith('/node_modules')) {
        const devOnly = [
          '/node_modules/typescript',
          '/node_modules/vite',
          '/node_modules/eslint',
          '/node_modules/@typescript-eslint',
          '/node_modules/electron-squirrel-startup',
          '/node_modules/@electron-forge',
          '/node_modules/@electron/fuses',
          '/node_modules/electron/',
          '/node_modules/.bin',
        ];
        if (devOnly.some(d => path.startsWith(d))) return true;
        return false;
      }
      // Exclude everything else not needed at runtime
      if (path.startsWith('/src/')) return true;
      if (path.startsWith('/scripts/')) return true;
      if (path.startsWith('/out/')) return true;
      if (path.startsWith('/.git')) return true;
      if (path.startsWith('/assets/icon.iconset')) return true;
      if (path === '/assets/icon_source.png') return true;
      return false;
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({ name: 'Orbiv' }),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: false,
    }),
  ],
};

export default config;
