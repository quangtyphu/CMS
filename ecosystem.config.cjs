/** PM2 — game-server (CMS). Tự restart khi sửa server.js hoặc lib/*. */
module.exports = {
  apps: [
    {
      name: 'game-server',
      script: './server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: ['server.js', 'lib'],
      watch_delay: 1000,
      ignore_watch: [
        'node_modules',
        'game_data',
        'public',
        'scripts',
        '.git',
        'logs',
        '*.db',
        '*.sqlite',
        '*.log',
      ],
      max_restarts: 20,
      min_uptime: '5s',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
