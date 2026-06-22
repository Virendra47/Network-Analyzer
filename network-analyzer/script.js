// ============================================================
// SCRIPT.JS - Complete Application Logic
// ============================================================

// ============================================================
// STATE
// ============================================================
let configFiles = {};
let parsedDevices = [];
let networkTopology = { nodes: [], edges: [] };
let networkInstance = null;

// ============================================================
// SAMPLE DATA
// ============================================================
const samples = {
    error: {
        "R1_config.dump": `hostname R1\n!\ninterface FastEthernet0/0\n ip address 10.1.1.1 255.255.255.0\n duplex auto\n speed auto\n!\ninterface FastEthernet1/0\n ip address 10.1.2.1 255.255.255.0\n mtu 1400\n duplex auto\n speed auto\n!\nrouter ospf 1\n network 10.1.1.0 0.0.0.255 area 0\n network 10.1.2.0 0.0.0.255 area 0\n!\nend`,
        "R2_config.dump": `hostname R2\n!\ninterface FastEthernet0/0\n ip address 10.1.1.2 255.255.255.0\n duplex auto\n speed auto\n!\ninterface FastEthernet1/0\n ip address 10.1.3.1 255.255.255.0\n mtu 1500\n duplex auto\n speed auto\n!\nrouter ospf 1\n network 10.1.1.0 0.0.0.255 area 0\n network 10.1.3.0 0.0.0.255 area 0\n!\nend`,
        "R3_config.dump": `hostname R3\n!\ninterface FastEthernet0/0\n ip address 10.1.2.2 255.255.255.0\n mtu 1500\n duplex auto\n speed auto\n!\ninterface FastEthernet1/0\n ip address 10.1.3.2 255.255.255.0\n mtu 1500\n duplex auto\n speed auto\n!\nrouter ospf 1\n network 10.1.2.0 0.0.0.255 area 0\n network 10.1.3.0 0.0.0.255 area 0\n!\nend`,
        "PC1.txt": `hostname PC1\n!\ninterface FastEthernet0/0\n ip address 10.1.1.10 255.255.255.0\n description Connection to R1\n duplex full\n speed 100\n no shutdown\n!\nip default-gateway 10.1.1.1\n!\nend`
    },
    clean: {
        "R1_config.dump": `hostname R1\n!\ninterface FastEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n mtu 1500\n!\ninterface FastEthernet0/1\n ip address 192.168.2.1 255.255.255.0\n mtu 1500\n!\nend`,
        "R2_config.dump": `hostname R2\n!\ninterface FastEthernet0/0\n ip address 192.168.1.2 255.255.255.0\n mtu 1500\n!\ninterface FastEthernet0/1\n ip address 192.168.3.1 255.255.255.0\n mtu 1500\n!\nend`,
        "R3_config.dump": `hostname R3\n!\ninterface FastEthernet0/0\n ip address 192.168.2.2 255.255.255.0\n mtu 1500\n!\ninterface FastEthernet0/1\n ip address 192.168.3.2 255.255.255.0\n mtu 1500\n!\nend`,
        "PC1.txt": `hostname PC1\n!\ninterface FastEthernet0/0\n ip address 192.168.1.10 255.255.255.0\n no shutdown\n!\nip default-gateway 192.168.1.1\n!\nend`
    }
};

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
function ipToLong(ip) {
    if (!ip) return 0;
    const parts = ip.split('.');
    if (parts.length !== 4) return 0;
    return parts.reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0);
}

function getNetworkAddress(ip, mask) {
    if (!ip || !mask) return null;
    try {
        const ipLong = ipToLong(ip);
        const maskLong = ipToLong(mask);
        const net = ipLong & maskLong;
        return [(net >> 24) & 255, (net >> 16) & 255, (net >> 8) & 255, net & 255].join('.');
    } catch (e) {
        return null;
    }
}

function getCidr(mask) {
    if (!mask) return 0;
    return mask.split('.').map(o => (parseInt(o, 10) >>> 0).toString(2).split('1').length - 1).reduce((a, b) => a + b, 0);
}

// ============================================================
// PARSER
// ============================================================
function parseConfig(text) {
    if (!text || typeof text !== 'string') return null;
    const lines = text.split('\n');
    let device = {
        hostname: null,
        interfaces: [],
        ospf: { networks: [] },
        vlans: [],
        type: 'router',
        defaultGateway: null,
        domainName: null,
        nameServers: []
    };
    let currentIntf = null;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('!')) continue;
        
        if (trimmed.startsWith('hostname')) {
            device.hostname = trimmed.split(' ')[1];
            continue;
        }
        if (trimmed.startsWith('ip domain-name')) {
            device.domainName = trimmed.split(' ')[2];
            continue;
        }
        if (trimmed.startsWith('ip name-server')) {
            const parts = trimmed.split(' ');
            if (parts.length >= 3) device.nameServers.push(parts[2]);
            continue;
        }
        if (trimmed.startsWith('ip default-gateway')) {
            device.defaultGateway = trimmed.split(' ')[2];
            device.type = 'pc';
            continue;
        }
        if (trimmed.startsWith('interface')) {
            currentIntf = {
                name: trimmed.split(' ')[1],
                ip_address: null,
                subnet_mask: null,
                mtu: 1500,
                vlan: null,
                speed: null,
                duplex: null,
                description: null,
                shutdown: false
            };
            device.interfaces.push(currentIntf);
            continue;
        }
        if (currentIntf) {
            if (trimmed.startsWith('ip address')) {
                const parts = trimmed.split(' ');
                if (parts.length >= 4) {
                    currentIntf.ip_address = parts[2];
                    currentIntf.subnet_mask = parts[3];
                }
                continue;
            }
            if (trimmed.startsWith('mtu')) {
                currentIntf.mtu = parseInt(trimmed.split(' ')[1], 10) || 1500;
                continue;
            }
            if (trimmed.startsWith('speed')) {
                currentIntf.speed = trimmed.split(' ')[1];
                continue;
            }
            if (trimmed.startsWith('duplex')) {
                currentIntf.duplex = trimmed.split(' ')[1];
                continue;
            }
            if (trimmed.startsWith('description')) {
                currentIntf.description = trimmed.substring(12).trim();
                continue;
            }
            if (trimmed.startsWith('vlan')) {
                currentIntf.vlan = parseInt(trimmed.split(' ')[1], 10);
                if (!device.vlans.includes(currentIntf.vlan)) device.vlans.push(currentIntf.vlan);
                continue;
            }
            if (trimmed === 'shutdown') {
                currentIntf.shutdown = true;
                continue;
            }
            if (trimmed === 'no shutdown') {
                currentIntf.shutdown = false;
                continue;
            }
        }
        if (trimmed.startsWith('network') && device.ospf) {
            const parts = trimmed.split(' ');
            if (parts.length >= 5) {
                device.ospf.networks.push({ address: parts[1], wildcard: parts[2], area: parts[4] });
            }
            continue;
        }
    }
    device.interfaces = device.interfaces.filter(i => i.ip_address && i.subnet_mask);
    return device;
}

function parseAllConfigs(files) {
    const devices = [];
    for (const [filename, content] of Object.entries(files)) {
        const device = parseConfig(content);
        if (device && device.hostname) {
            device.filename = filename;
            devices.push(device);
        }
    }
    return devices;
}

// ============================================================
// TOPOLOGY BUILDER
// ============================================================
function buildTopology(devices) {
    if (!devices || devices.length === 0) return { nodes: [], edges: [] };
    
    const nodes = devices.filter(d => d && d.hostname).map(d => ({
        id: d.hostname,
        label: d.hostname,
        group: d.type || 'router',
        title: d.type === 'pc' ? '💻 PC / End Device' : '🔄 Router',
        type: d.type || 'router'
    }));
    
    const edges = [];
    const connections = new Set();
    
    for (let i = 0; i < devices.length; i++) {
        for (let j = i + 1; j < devices.length; j++) {
            const a = devices[i], b = devices[j];
            if (!a || !b || !a.hostname || !b.hostname) continue;
            for (const intfA of a.interfaces) {
                for (const intfB of b.interfaces) {
                    const netA = getNetworkAddress(intfA.ip_address, intfA.subnet_mask);
                    const netB = getNetworkAddress(intfB.ip_address, intfB.subnet_mask);
                    if (netA && netA === netB) {
                        const key1 = `${a.hostname}-${b.hostname}`;
                        const key2 = `${b.hostname}-${a.hostname}`;
                        if (!connections.has(key1) && !connections.has(key2)) {
                            edges.push({
                                from: a.hostname,
                                to: b.hostname,
                                label: `${netA}/${getCidr(intfA.subnet_mask)}`,
                                intfA: intfA.name,
                                intfB: intfB.name,
                                speed: intfA.speed || intfB.speed || 'auto',
                                mtu: Math.min(intfA.mtu, intfB.mtu)
                            });
                            connections.add(key1);
                        }
                    }
                }
            }
        }
    }
    return { nodes, edges };
}

function findPathBFS(start, end, topology) {
    if (!start || !end || start === end) return null;
    if (!topology || !topology.nodes || topology.nodes.length === 0) return null;
    
    const adj = {};
    topology.nodes.forEach(n => { if (n && n.id) adj[n.id] = []; });
    topology.edges.forEach(e => {
        if (e.from && e.to) {
            if (!adj[e.from]) adj[e.from] = [];
            if (!adj[e.to]) adj[e.to] = [];
            adj[e.from].push(e.to);
            adj[e.to].push(e.from);
        }
    });
    
    const queue = [[start]];
    const visited = new Set([start]);
    while (queue.length > 0) {
        const path = queue.shift();
        const node = path[path.length - 1];
        if (node === end) return path;
        for (const neighbor of (adj[node] || [])) {
            if (!visited.has(neighbor)) {
                visited.add(neighbor);
                queue.push([...path, neighbor]);
            }
        }
    }
    return null;
}

// ============================================================
// VALIDATOR
// ============================================================
function validateNetwork(devices, topology) {
    const errors = [], warnings = [], suggestions = [];
    if (!devices || devices.length === 0) {
        warnings.push({ type: 'No Devices', message: 'No devices found to validate.' });
        return { errors, warnings, suggestions };
    }
    
    const ipMap = new Map();
    devices.forEach(d => {
        if (!d) return;
        d.interfaces.forEach(intf => {
            if (intf.ip_address) {
                const key = intf.ip_address;
                const entry = `${d.hostname}(${intf.name})`;
                if (ipMap.has(key)) ipMap.get(key).push(entry);
                else ipMap.set(key, [entry]);
            }
        });
    });
    ipMap.forEach((locs, ip) => {
        if (locs.length > 1) {
            errors.push({ type: 'Duplicate IP', message: `IP ${ip} used on: ${locs.join(', ')}` });
        }
    });
    
    topology.edges.forEach(edge => {
        const a = devices.find(d => d.hostname === edge.from);
        const b = devices.find(d => d.hostname === edge.to);
        if (!a || !b) return;
        const intfA = a.interfaces.find(i => i.name === edge.intfA);
        const intfB = b.interfaces.find(i => i.name === edge.intfB);
        if (intfA && intfB && intfA.mtu !== intfB.mtu) {
            errors.push({
                type: 'MTU Mismatch',
                message: `MTU mismatch: ${edge.from}(${intfA.name})[${intfA.mtu}] ↔ ${edge.to}(${intfB.name})[${intfB.mtu}]`
            });
        }
    });
    
    const connectedNodes = new Set();
    topology.edges.forEach(e => { connectedNodes.add(e.from); connectedNodes.add(e.to); });
    devices.forEach(d => {
        if (d && d.hostname && !connectedNodes.has(d.hostname)) {
            warnings.push({ type: 'Isolated Device', message: `${d.hostname} has no network connections.` });
        }
    });
    
    const hasOSPF = devices.some(d => d && d.ospf && d.ospf.networks.length > 0);
    if (hasOSPF && topology.edges.length === 0) {
        warnings.push({ type: 'OSPF No Links', message: 'OSPF configured but no links detected.' });
    }
    
    if (errors.length === 0 && warnings.length === 0) {
        suggestions.push({ type: 'All Good', message: 'No issues found! Configuration looks perfect.' });
    }
    
    return { errors, warnings, suggestions };
}

// ============================================================
// MODAL FUNCTIONS
// ============================================================
function showModal(title, message, icon = '🎉') {
    const modal = document.getElementById('modal');
    document.getElementById('modal-icon').textContent = icon;
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-message').textContent = message;
    modal.classList.add('visible');
}

function closeModal() {
    document.getElementById('modal').classList.remove('visible');
}

// ============================================================
// SAMPLE LOADER
// ============================================================
function loadSample(type) {
    configFiles = {};
    const data = samples[type];
    if (!data) { showModal('Error', 'Sample not found.', '❌'); return; }
    
    const container = document.getElementById('file-list');
    container.innerHTML = '';
    Object.keys(data).forEach(filename => {
        configFiles[filename] = data[filename];
        container.innerHTML += `<div class="file-item">${filename}</div>`;
    });
    showModal('✅ Loaded', `Loaded ${Object.keys(data).length} sample config files. Click "Analyze Network" to continue.`, '📁');
}

// ============================================================
// FILE INPUT
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
    const fileInput = document.getElementById('file-input');
    const uploadArea = document.getElementById('upload-area');
    
    if (fileInput) {
        fileInput.addEventListener('change', function(e) {
            const files = Array.from(e.target.files);
            if (files.length === 0) return;
            const container = document.getElementById('file-list');
            container.innerHTML = '';
            files.forEach(file => {
                const reader = new FileReader();
                reader.onload = (ev) => {
                    configFiles[file.name] = ev.target.result;
                    container.innerHTML += `<div class="file-item">${file.name}</div>`;
                };
                reader.readAsText(file);
            });
        });
    }
    
    if (uploadArea) {
        uploadArea.addEventListener('dragover', function(e) {
            e.preventDefault();
            this.classList.add('dragover');
        });
        uploadArea.addEventListener('dragleave', function(e) {
            e.preventDefault();
            this.classList.remove('dragover');
        });
        uploadArea.addEventListener('drop', function(e) {
            e.preventDefault();
            this.classList.remove('dragover');
            const files = Array.from(e.dataTransfer.files);
            if (files.length === 0) return;
            const container = document.getElementById('file-list');
            container.innerHTML = '';
            files.forEach(file => {
                const reader = new FileReader();
                reader.onload = (ev) => {
                    configFiles[file.name] = ev.target.result;
                    container.innerHTML += `<div class="file-item">${file.name}</div>`;
                };
                reader.readAsText(file);
            });
        });
    }
    
    // Live search suggestions
    const searchInput = document.getElementById('search-input');
    const suggestions = document.getElementById('search-suggestions');
    if (searchInput && suggestions) {
        searchInput.addEventListener('input', function() {
            const query = this.value.trim().toLowerCase();
            if (!query || !networkInstance) {
                suggestions.classList.remove('show');
                return;
            }
            const nodes = networkInstance.getData().nodes.get();
            const matches = nodes.filter(n => 
                n.id.toLowerCase().includes(query) || 
                (n.label && n.label.toLowerCase().includes(query))
            );
            if (matches.length > 0) {
                suggestions.innerHTML = matches.map(n => 
                    `<div class="search-suggestion-item" onclick="selectSuggestion('${n.id}')">
                        ${n.id} ${n.label && n.label !== n.id ? `(${n.label})` : ''}
                    </div>`
                ).join('');
                suggestions.classList.add('show');
            } else {
                suggestions.innerHTML = `<div class="search-suggestion-item" style="color:rgba(255,255,255,0.3);cursor:default;">No matches found</div>`;
                suggestions.classList.add('show');
            }
        });
        document.addEventListener('click', function(e) {
            if (!e.target.closest('.search-wrapper')) {
                suggestions.classList.remove('show');
            }
        });
        searchInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') { searchDevice(); suggestions.classList.remove('show'); }
        });
    }
    
    document.addEventListener('keydown', function(e) {
        if (e.ctrlKey && e.key === 'Enter') analyzeNetwork();
    });
});

function selectSuggestion(id) {
    document.getElementById('search-input').value = id;
    document.getElementById('search-suggestions').classList.remove('show');
    searchDevice();
}

// ============================================================
// TAB SWITCHER
// ============================================================
function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('#tab-content > div').forEach(div => {
        div.classList.add('hidden');
    });
    const target = document.getElementById(`${tab}-tab`);
    if (target) target.classList.remove('hidden');
    if (tab === 'topology' && networkInstance) {
        setTimeout(() => networkInstance.fit(), 100);
    }
}

// ============================================================
// UPDATE STATS
// ============================================================
function updateStats(devices, topology, validation) {
    document.getElementById('stat-devices').textContent = devices.length;
    document.getElementById('stat-links').textContent = topology.edges.length;
    document.getElementById('stat-errors').textContent = validation.errors.length;
    document.getElementById('stat-warnings').textContent = validation.warnings.length;
}

// ============================================================
// DISPLAY FUNCTIONS
// ============================================================
function displayTopology(topology) {
    const container = document.getElementById('mynetwork');
    container.innerHTML = '';
    if (!topology || !topology.nodes || topology.nodes.length === 0) {
        container.innerHTML = '<div class="text-center py-10" style="color:rgba(255,255,255,0.2);">No devices to display.</div>';
        return;
    }
    
    const nodes = topology.nodes.map(n => {
        const base = { id: n.id, label: n.label || n.id, title: n.title || n.id, group: n.group || 'router' };
        if (n.type === 'pc') {
            return { 
                ...base, 
                shape: 'icon', 
                icon: { code: '💻', size: 30 }, 
                color: { border: '#60a5fa', background: 'rgba(96, 165, 250, 0.2)' }, 
                font: { color: '#e5e7eb', size: 14 } 
            };
        } else {
            return { 
                ...base, 
                shape: 'dot', 
                size: 28, 
                color: { border: '#a78bfa', background: 'rgba(167, 139, 250, 0.2)' }, 
                font: { color: '#e5e7eb', size: 14 }, 
                borderWidth: 2 
            };
        }
    });
    
    const edges = topology.edges.map(e => ({
        from: e.from,
        to: e.to,
        label: e.label || '',
        title: `Subnet: ${e.label || 'N/A'}\nMTU: ${e.mtu || 'N/A'}\nSpeed: ${e.speed || 'auto'}`,
        color: { color: 'rgba(167, 139, 250, 0.3)' },
        font: { size: 10, align: 'top', color: 'rgba(255,255,255,0.4)' },
        smooth: { type: 'continuous' },
        width: e.speed && parseInt(e.speed) > 1000 ? 3 : 1
    }));
    
    const data = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };
    const options = {
        layout: { hierarchical: false },
        edges: { 
            smooth: { type: 'continuous' }, 
            arrows: { to: { enabled: false } },
            shadow: { enabled: true, color: 'rgba(167, 139, 250, 0.1)', size: 5 }
        },
        physics: { 
            enabled: true, 
            solver: 'barnesHut', 
            barnesHut: { gravitationalConstant: -3000, centralGravity: 0.3 },
            stabilization: { iterations: 100 }
        },
        interaction: { 
            dragNodes: true, 
            dragView: true, 
            zoomView: true, 
            tooltipDelay: 100 
        }
    };
    
    networkInstance = new vis.Network(container, data, options);
    setTimeout(() => { if (networkInstance) networkInstance.fit(); }, 300);
    
    // Update dropdowns
    const selects = ['source-node', 'dest-node', 'compare-device1', 'compare-device2'];
    const nodeNames = topology.nodes.map(n => n.id);
    selects.forEach(id => {
        const select = document.getElementById(id);
        if (!select) return;
        const currentValue = select.value;
        select.innerHTML = '';
        nodeNames.forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        });
        if (currentValue && nodeNames.includes(currentValue)) select.value = currentValue;
    });
}

function displayDevices(devices) {
    const container = document.getElementById('devices-tab');
    container.innerHTML = '';
    if (!devices || devices.length === 0) {
        container.innerHTML = '<p style="color:rgba(255,255,255,0.2);">No devices found.</p>';
        return;
    }
    devices.forEach(d => {
        if (!d || !d.hostname) return;
        const interfaces = d.interfaces.map(i => `
            <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;font-size:13px;padding:8px 12px;border-radius:8px;background:rgba(255,255,255,0.02);margin-bottom:4px;border:1px solid rgba(255,255,255,0.03);">
                <span><strong style="color:#a78bfa;">${i.name}</strong>: ${i.ip_address}/${i.subnet_mask}</span>
                <span style="color:rgba(255,255,255,0.3);font-size:12px;">
                    MTU: ${i.mtu} ${i.vlan ? '| VLAN: '+i.vlan : ''} ${i.shutdown ? '| 🔴 Shutdown' : '| 🟢 Active'}
                    ${i.speed ? '| '+i.speed+'Mbps' : ''}
                </span>
            </div>
        `).join('');
        container.innerHTML += `
            <div style="padding:16px;border:1px solid rgba(255,255,255,0.05);border-radius:12px;margin-bottom:12px;background:rgba(255,255,255,0.01);">
                <div style="display:flex;justify-content:space-between;align-items:start;flex-wrap:wrap;">
                    <div>
                        <h4 style="color:#a78bfa;font-size:18px;font-weight:600;">${d.hostname}</h4>
                        <p style="color:rgba(255,255,255,0.3);font-size:13px;">${d.type === 'pc' ? '💻 PC / End Device' : '🔄 Router'}</p>
                        ${d.domainName ? `<p style="color:rgba(255,255,255,0.2);font-size:12px;">Domain: ${d.domainName}</p>` : ''}
                        ${d.defaultGateway ? `<p style="color:rgba(255,255,255,0.2);font-size:12px;">Gateway: ${d.defaultGateway}</p>` : ''}
                    </div>
                    ${d.vlans && d.vlans.length > 0 ? `<div style="display:flex;flex-wrap:wrap;gap:4px;">${d.vlans.map(v => `<span class="vlan-tag vlan-${(v % 4) * 10 + 10}">VLAN ${v}</span>`).join('')}</div>` : ''}
                </div>
                <div style="margin-top:8px;">${interfaces}</div>
            </div>
        `;
    });
}

function displayValidation(validation) {
    const container = document.getElementById('validation-tab');
    container.innerHTML = '';
    if (!validation) { container.innerHTML = '<p style="color:rgba(255,255,255,0.2);">No validation data.</p>'; return; }
    
    const { errors, warnings, suggestions } = validation;
    let summary = '';
    if (errors.length === 0 && warnings.length === 0) {
        summary = `<div class="badge-success" style="padding:16px;border-radius:12px;">
            <h4 style="font-weight:600;color:#6ee7b7;">✅ Perfect!</h4>
            <p style="color:rgba(255,255,255,0.4);margin-top:4px;">No issues found in your network configuration.</p>
        </div>`;
    } else {
        summary = `<div style="padding:16px;border-radius:12px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.04);">
            <div style="display:flex;gap:12px;flex-wrap:wrap;">
                <span class="badge badge-error">${errors.length} Errors</span>
                <span class="badge badge-warning">${warnings.length} Warnings</span>
                ${suggestions && suggestions.length > 0 ? `<span class="badge badge-info">${suggestions.length} Suggestions</span>` : ''}
            </div>
        </div>`;
    }
    container.innerHTML = summary;
    
    if (errors.length > 0) {
        container.innerHTML += `<div class="badge-error" style="padding:16px;border-radius:12px;margin-top:12px;">
            <h4 style="font-weight:600;color:#fca5a5;">❌ Errors (${errors.length})</h4>
            <ul style="list-style:disc;list-style-position:inside;margin-top:8px;">
                ${errors.map(e => `<li style="font-size:14px;color:rgba(255,255,255,0.6);margin-top:4px;">${e.message}</li>`).join('')}
            </ul>
        </div>`;
    }
    if (warnings.length > 0) {
        container.innerHTML += `<div class="badge-warning" style="padding:16px;border-radius:12px;margin-top:12px;">
            <h4 style="font-weight:600;color:#fdba74;">⚠️ Warnings (${warnings.length})</h4>
            <ul style="list-style:disc;list-style-position:inside;margin-top:8px;">
                ${warnings.map(w => `<li style="font-size:14px;color:rgba(255,255,255,0.6);margin-top:4px;">${w.message}</li>`).join('')}
            </ul>
        </div>`;
    }
    if (suggestions && suggestions.length > 0) {
        container.innerHTML += `<div class="badge-info" style="padding:16px;border-radius:12px;margin-top:12px;">
            <h4 style="font-weight:600;color:#93c5fd;">💡 Suggestions</h4>
            <ul style="list-style:disc;list-style-position:inside;margin-top:8px;">
                ${suggestions.map(s => `<li style="font-size:14px;color:rgba(255,255,255,0.6);margin-top:4px;">${s.message}</li>`).join('')}
            </ul>
        </div>`;
    }
}

function displayVLANs(devices) {
    const container = document.getElementById('vlan-results');
    container.innerHTML = '';
    if (!devices || devices.length === 0) {
        container.innerHTML = '<p style="color:rgba(255,255,255,0.2);">No devices found.</p>';
        return;
    }
    const vlanMap = new Map();
    devices.forEach(d => {
        if (!d) return;
        d.interfaces.forEach(i => {
            if (i.vlan) {
                if (!vlanMap.has(i.vlan)) vlanMap.set(i.vlan, []);
                vlanMap.get(i.vlan).push(`${d.hostname}(${i.name})`);
            }
        });
    });
    if (vlanMap.size === 0) {
        container.innerHTML = '<p style="color:rgba(255,255,255,0.2);">No VLANs detected in configurations.</p>';
        return;
    }
    const vlanColors = ['vlan-10', 'vlan-20', 'vlan-30', 'vlan-40'];
    let idx = 0;
    vlanMap.forEach((devices, vlan) => {
        container.innerHTML += `
            <div style="padding:12px 16px;background:rgba(255,255,255,0.02);border-radius:10px;margin-bottom:8px;border:1px solid rgba(255,255,255,0.03);">
                <span class="vlan-tag ${vlanColors[idx % vlanColors.length]}">VLAN ${vlan}</span>
                <span style="color:rgba(255,255,255,0.5);font-size:14px;margin-left:12px;">${devices.join(', ')}</span>
                <span style="color:rgba(255,255,255,0.2);font-size:12px;margin-left:8px;">(${devices.length} interfaces)</span>
            </div>
        `;
        idx++;
    });
}

// ============================================================
// SEARCH - FIXED
// ============================================================
function searchDevice() {
    const query = document.getElementById('search-input').value.trim();
    if (!query) { showModal('Info', 'Please enter a device name to search.', '🔍'); return; }
    if (!networkInstance) { showModal('Error', 'No topology loaded. Please analyze first.', '❌'); return; }
    
    try {
        const nodes = networkInstance.getData().nodes.get();
        const found = nodes.find(n => 
            n.id.toLowerCase().includes(query.toLowerCase()) ||
            (n.label && n.label.toLowerCase().includes(query.toLowerCase()))
        );
        if (found) {
            networkInstance.selectNodes([found.id]);
            networkInstance.focus(found.id, { 
                scale: 1.5, 
                animation: { 
                    duration: 500, 
                    easingFunction: 'easeInOutQuad' 
                } 
            });
            
            const updatedNodes = nodes.map(n => {
                if (n.id === found.id) {
                    return { 
                        ...n, 
                        color: { 
                            border: '#fbbf24', 
                            background: 'rgba(251, 191, 36, 0.3)' 
                        }, 
                        font: { 
                            color: '#ffffff', 
                            size: 18, 
                            bold: true 
                        } 
                    };
                }
                return n;
            });
            networkInstance.getData().nodes.update(updatedNodes);
            
            setTimeout(() => {
                const resetNodes = networkInstance.getData().nodes.get().map(n => {
                    if (n.id === found.id) {
                        const original = nodes.find(orig => orig.id === n.id);
                        return { 
                            ...n, 
                            color: original.color || { 
                                border: '#a78bfa', 
                                background: 'rgba(167, 139, 250, 0.2)' 
                            }, 
                            font: { 
                                color: '#e5e7eb', 
                                size: 14, 
                                bold: false 
                            } 
                        };
                    }
                    return n;
                });
                networkInstance.getData().nodes.update(resetNodes);
            }, 3000);
            
            showModal('✅ Found!', `Device "${found.id}" found and highlighted!`, '🎯');
        } else {
            showModal('❌ Not Found', `No device matching "${query}" found.`, '🔍');
        }
    } catch (error) {
        console.error('Search error:', error);
        showModal('Error', 'Search failed. Please try again.', '❌');
    }
}

function clearSearch() {
    document.getElementById('search-input').value = '';
    document.getElementById('search-suggestions').classList.remove('show');
    if (networkInstance) {
        networkInstance.unselectAll();
        networkInstance.fit({ animation: { duration: 500 } });
        const nodes = networkInstance.getData().nodes.get();
        const resetNodes = nodes.map(n => ({
            ...n,
            color: n.type === 'pc' ? 
                { border: '#60a5fa', background: 'rgba(96, 165, 250, 0.2)' } : 
                { border: '#a78bfa', background: 'rgba(167, 139, 250, 0.2)' },
            font: { color: '#e5e7eb', size: 14, bold: false }
        }));
        networkInstance.getData().nodes.update(resetNodes);
    }
}

// ============================================================
// EXPORT
// ============================================================
function exportTopology(format) {
    if (!networkInstance) { showModal('Error', 'No topology to export. Please analyze first.', '❌'); return; }
    const canvas = document.querySelector('#mynetwork canvas');
    if (!canvas) { showModal('Error', 'Canvas not found.', '❌'); return; }
    
    if (format === 'json') {
        const data = { 
            nodes: networkInstance.getData().nodes.get(), 
            edges: networkInstance.getData().edges.get(), 
            exportedAt: new Date().toISOString() 
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `topology-${Date.now()}.json`;
        link.href = url;
        link.click();
        URL.revokeObjectURL(url);
        showModal('✅ Success', 'JSON data exported!', '📄');
        return;
    }
    
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const ctx = exportCanvas.getContext('2d');
    ctx.fillStyle = '#0a0a1a';
    ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    ctx.drawImage(canvas, 0, 0);
    const link = document.createElement('a');
    const ext = format === 'jpg' ? 'jpg' : 'png';
    const mimeType = format === 'jpg' ? 'image/jpeg' : 'image/png';
    link.download = `topology-${Date.now()}.${ext}`;
    link.href = exportCanvas.toDataURL(mimeType, 1.0);
    link.click();
    showModal('✅ Success', `Topology exported as ${format.toUpperCase()}!`, '📸');
}

// ============================================================
// SIMULATION - FIXED
// ============================================================
function findPath() {
    const src = document.getElementById('source-node').value;
    const dst = document.getElementById('dest-node').value;
    const container = document.getElementById('path-results');
    
    if (!src || !dst) {
        container.innerHTML = '<div class="badge-warning" style="padding:16px;border-radius:12px;">Please select source and destination devices.</div>';
        return;
    }
    if (src === dst) {
        container.innerHTML = '<div class="badge-warning" style="padding:16px;border-radius:12px;">Source and destination must be different devices.</div>';
        return;
    }
    if (!networkTopology || networkTopology.nodes.length === 0) {
        container.innerHTML = '<div class="badge-error" style="padding:16px;border-radius:12px;">No topology loaded. Please analyze first.</div>';
        return;
    }
    
    const path = findPathBFS(src, dst, networkTopology);
    if (!path) {
        container.innerHTML = `<div class="badge-error" style="padding:16px;border-radius:12px;">
            ❌ No path found from <strong style="color:#fff;">${src}</strong> to <strong style="color:#fff;">${dst}</strong>.
            <p style="color:rgba(255,255,255,0.4);font-size:13px;margin-top:4px;">The network might be disconnected.</p>
        </div>`;
        return;
    }
    
    let html = `<div class="badge-success" style="padding:16px;border-radius:12px;">
        <h4 style="font-weight:600;color:#6ee7b7;">✅ Path Found!</h4>
        <p style="margin-top:6px;color:rgba(255,255,255,0.8);font-size:15px;">
            <strong style="color:#fff;">${path.join(' → ')}</strong>
        </p>
        <div style="display:flex;gap:20px;margin-top:8px;color:rgba(255,255,255,0.3);font-size:13px;">
            <span>Hops: ${path.length - 1}</span>
            <span>Devices: ${path.length}</span>
        </div>
    </div>`;
    
    // Link Failure Simulation
    html += `<div style="margin-top:16px;">
        <h4 style="color:rgba(255,255,255,0.5);font-size:14px;font-weight:600;margin-bottom:10px;">🔄 Link Failure Simulation</h4>
        <div style="space-y:8px;">`;
    
    let hasAlternative = false;
    for (let i = 0; i < path.length - 1; i++) {
        const from = path[i];
        const to = path[i + 1];
        const failedLink = `${from} - ${to}`;
        
        const tempTopology = JSON.parse(JSON.stringify(networkTopology));
        tempTopology.edges = tempTopology.edges.filter(e => 
            !((e.from === from && e.to === to) || (e.from === to && e.to === from))
        );
        
        const altPath = findPathBFS(src, dst, tempTopology);
        if (altPath) {
            hasAlternative = true;
            html += `<div class="badge-info" style="padding:10px 16px;border-radius:10px;font-size:13px;margin-bottom:6px;">
                If link <strong style="color:#fff;">${failedLink}</strong> fails → 
                Alternative: <strong style="color:#93c5fd;">${altPath.join(' → ')}</strong>
            </div>`;
        } else {
            html += `<div class="badge-error" style="padding:10px 16px;border-radius:10px;font-size:13px;margin-bottom:6px;">
                ⚠️ If link <strong style="color:#fff;">${failedLink}</strong> fails → 
                <span style="color:#fca5a5;">NETWORK DISCONNECTED!</span>
            </div>`;
        }
    }
    
    if (!hasAlternative) {
        html += `<div class="badge-warning" style="padding:10px 16px;border-radius:10px;font-size:13px;">
            💡 No alternative paths available. This is a single point of failure.
        </div>`;
    }
    
    html += `</div></div>`;
    container.innerHTML = html;
}

// ============================================================
// COMPARE
// ============================================================
function compareConfigs() {
    const name1 = document.getElementById('compare-device1').value;
    const name2 = document.getElementById('compare-device2').value;
    const container = document.getElementById('compare-results');
    
    if (!name1 || !name2 || name1 === name2) {
        container.innerHTML = '<p style="color:rgba(255,255,255,0.2);">Select two different devices to compare.</p>';
        return;
    }
    
    const config1 = Object.entries(configFiles).find(([key]) => key.includes(name1));
    const config2 = Object.entries(configFiles).find(([key]) => key.includes(name2));
    
    if (!config1 || !config2) {
        container.innerHTML = '<p style="color:rgba(255,255,255,0.2);">Configuration files not found.</p>';
        return;
    }
    
    const lines1 = config1[1].split('\n');
    const lines2 = config2[1].split('\n');
    const maxLen = Math.max(lines1.length, lines2.length);
    
    let html = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:8px;">
        <div style="color:#a78bfa;font-weight:600;padding:8px 12px;background:rgba(255,255,255,0.02);border-radius:8px;border:1px solid rgba(255,255,255,0.03);">${name1}</div>
        <div style="color:#60a5fa;font-weight:600;padding:8px 12px;background:rgba(255,255,255,0.02);border-radius:8px;border:1px solid rgba(255,255,255,0.03);">${name2}</div>`;
    
    let diffCount = 0;
    for (let i = 0; i < maxLen; i++) {
        const l1 = i < lines1.length ? lines1[i] || '' : '';
        const l2 = i < lines2.length ? lines2[i] || '' : '';
        const same = l1 === l2;
        if (!same) diffCount++;
        
        const cls1 = same ? 'diff-same' : (l1 ? 'diff-added' : 'diff-removed');
        const cls2 = same ? 'diff-same' : (l2 ? 'diff-added' : 'diff-removed');
        
        html += `<div class="${cls1}" style="font-size:11px;padding:3px 8px;font-family:monospace;color:${same ? 'rgba(255,255,255,0.15)' : 'inherit'};">${l1 || '—'}</div>
                 <div class="${cls2}" style="font-size:11px;padding:3px 8px;font-family:monospace;color:${same ? 'rgba(255,255,255,0.15)' : 'inherit'};">${l2 || '—'}</div>`;
    }
    html += '</div>';
    html += `<div style="color:rgba(255,255,255,0.2);font-size:12px;padding:8px 12px;background:rgba(255,255,255,0.02);border-radius:8px;border:1px solid rgba(255,255,255,0.03);">
        Differences: <strong style="color:rgba(255,255,255,0.4);">${diffCount}</strong> lines differ | Total lines: ${maxLen}
    </div>`;
    container.innerHTML = html;
}

// ============================================================
// MAIN ANALYSIS
// ============================================================
function analyzeNetwork() {
    if (Object.keys(configFiles).length === 0) {
        showModal('⚠️ Error', 'Please load or upload configuration files first.', '📁');
        return;
    }
    
    const loading = document.getElementById('loading');
    const initialMsg = document.getElementById('initial-msg');
    if (loading) loading.classList.remove('hidden');
    if (initialMsg) initialMsg.classList.add('hidden');
    
    setTimeout(() => {
        try {
            parsedDevices = parseAllConfigs(configFiles);
            if (parsedDevices.length === 0) {
                showModal('❌ Error', 'No valid devices found in the configurations.', '❌');
                if (loading) loading.classList.add('hidden');
                return;
            }
            
            networkTopology = buildTopology(parsedDevices);
            const validation = validateNetwork(parsedDevices, networkTopology);
            
            displayTopology(networkTopology);
            displayDevices(parsedDevices);
            displayValidation(validation);
            displayVLANs(parsedDevices);
            updateStats(parsedDevices, networkTopology, validation);
            
            // Switch to topology tab after analysis
            switchTab('topology');
            
            if (loading) loading.classList.add('hidden');
            
            showModal(
                '✅ Analysis Complete',
                `Analyzed ${parsedDevices.length} devices with ${networkTopology.edges.length} links.\nFound ${validation.errors.length} errors and ${validation.warnings.length} warnings.`,
                '🎉'
            );
            
        } catch (error) {
            console.error('Analysis Error:', error);
            if (loading) loading.classList.add('hidden');
            showModal('❌ Error', 'Analysis failed. Check console for details.', '❌');
        }
    }, 600);
}