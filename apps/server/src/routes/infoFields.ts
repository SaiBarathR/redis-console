/** INFO fields that reveal file paths, run ids or other hosts' addresses; never sent to the browser. */
export const HIDDEN_INFO_FIELDS = new Set(['executable', 'config_file', 'master_host', 'master_port', 'tcp_port', 'run_id', 'master_replid', 'master_replid2']);
