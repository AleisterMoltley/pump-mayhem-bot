# Mayhem Farm

Ein Coin nach dem anderen. Der Bot legt ein frisches Wallet an, schiebt das ganze SOL dorthin, erstellt den Coin und kauft in einer zweiten Transaktion mit genau 1 SOL, weil Create und Buy zusammen nicht in ein Solana-Paket passen. Verkauft wird, sobald der Mayhem-Agent zum ersten Mal kauft. Die Creator-Fee wird in der Verkaufs-Transaktion auf den Creator-Vault geschoben und danach auf das deployende Wallet gezogen. Schlägt das Abholen fehl, bleibt das Wallet vorgemerkt und wird erneut versucht. Die Vault-Miete von etwa 0.00089088 SOL bleibt im Programmkonto.

Auf der live Kurve vom 29. Oktober 2026 liegt ein voller Verkauf von 1 SOL nach einem Agent-Kauf von 0.01 bis 0.25 SOL bei etwa 0.006 bis 0.021 SOL Verlust, vor Mint-Miete und Priorität. Der Mayhem-Trader ist signaturpflichtig und größenbegrenzt. Der Bot legt trotzdem genau 1 SOL und verkauft den ganzen Bestand.

## Railway

Variablen:

- `PRIVATE_KEY` — Start-Wallet, Base58 oder JSON-Array
- `DASHBOARD_PASSWORD` — mindestens 8 Zeichen, schützt die URL
- `PINATA_JWT`
- `SOLANA_RPC_URL` oder `HELIUS_API_KEY`

Volume anlegen und auf `/data` mounten: `railway volume add --mount-path /data`. Ohne `RAILWAY_VOLUME_MOUNT_PATH` oder `RAILWAY_VOLUME_NAME` startet der Bot auf Railway nicht. `wallets.jsonl` liegt auf diesem Volume, wird nie gelöscht und ein Schreibvorgang, der einen gespeicherten Key verlieren würde, bricht ab.

Der öffentliche RPC reicht für den Dauerbetrieb nicht. Dieselbe Helius-URL wie im Metadatascanner verwenden.
