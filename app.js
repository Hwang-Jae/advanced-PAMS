// Supabase 설정
const SUPABASE_URL = 'https://xtcoovvghttnwxwdttqa.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0Y29vdnZnaHR0bnd4d2R0dHFhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEzMDE3NzYsImV4cCI6MjA3Njg3Nzc3Nn0.Fmn9b1FoyklF5jw0oiLKp4JT1zRTY9iq9hiCog6HHpE';
const createClient = window.supabaseCreateClient;
let supabase;
let html5QrCodeScanner;
let scannerTargetInput = null;
let qrCodeInstance = null;
let ocrTargetInput = null;

let chartInstances = {
    warehouse: null,
    type: null
};

// 전역 상태 관리
const state = { 
    assets: [],      
    history: [],     
    stock: [],       
    departments: [], 
    users: [],       
    auditLogs: [], // [신규] 활동 로그
    selectedAssets: new Set(), 
    usageCounts: {}, 
    managerId: localStorage.getItem('mgrId') || '' 
};

// 매핑 상수
const TYPE_MAP = { "보전 자재": "EMM", "컴퓨터/노트북": "COM", "서버": "SVR", "도구": "TOL", "소모성 자재": "CSM", "기타": "ETC" };
const MONTH_MAP = ['A','B','C','D','E','F','G','H','I','J','K','L'];

// 유틸리티 함수
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s); 
const showLoading = (show, msg='처리 중...') => { $('#loading-text').innerText=msg; $('#loading-overlay').classList.toggle('hidden', !show); };
const alertMsg = (msg, err=false) => { alert(msg); if(err) console.error(msg); };

// [신규] 날짜를 YYYY-MM-DD 형식으로 변환 (ISO 8601)
const getISODate = (date) => date.toISOString().split('T')[0];

// =========================================
// [신규] 활동 로그(Audit Log) 헬퍼 함수
// =========================================
/**
 * @param {'CREATE' | 'UPDATE' | 'DELETE' | 'TRANSACTION'} actionType - 작업 유형
 * @param {string} targetTable - 대상 테이블 (예: 'MA_PRODUCT')
 * @param {string} targetId - 대상 레코드 ID (예: cmf_2, user_id)
 * @param {string} details - 로그 상세 내용
 */
async function logAudit(actionType, targetTable, targetId, details) {
    if (!state.managerId) {
        console.warn('관리자 ID가 없어 로그를 기록할 수 없습니다.');
        return;
    }
    
    try {
        const { error } = await supabase.from('AUDIT_LOG').insert({
            user_id: state.managerId,
            action_type: actionType,
            target_table: targetTable,
            target_id: targetId,
            details: details
        });
        if (error) throw error;
    } catch (e) {
        console.error('활동 로그 기록 실패:', e.message);
    }
}


// 초기화
async function init() {
    showLoading(true, '시스템 초기화 중...');
    try {
        supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
        if(state.managerId) $('#managerIdInput').value = state.managerId;
        
        await loadData(); 
        
        subscribe();      
        bindEvents();     

        $('#connection-status').innerText = '🟢 Connected (Realtime)';
    } catch(e) {
        $('#connection-status').innerText = '🔴 Connection Failed'; 
        alertMsg('초기화 실패: '+e.message, true);
    } finally { showLoading(false); }
}

// 이벤트 바인딩
function bindEvents() {
    const sidebar = $('#sidebar');
    const backdrop = $('#sidebar-backdrop');
    const navButtons = $$('#sidebar ul button[id^="nav-"]');

    // 모바일 메뉴 로직
    $('#open-menu-btn').onclick = () => {
        sidebar.classList.remove('-translate-x-full');
        backdrop.classList.remove('hidden');
    };
    backdrop.onclick = () => {
        sidebar.classList.add('-translate-x-full');
        backdrop.classList.add('hidden');
    };
    navButtons.forEach(btn => {
        btn.onclick = () => {
            const viewId = 'view-' + btn.id.replace('nav-', '');
            changeView(viewId);
            if (window.innerWidth < 768) { 
                sidebar.classList.add('-translate-x-full');
                backdrop.classList.add('hidden');
            }
        };
    });
    
    // --- 자산 모달/폼 이벤트 ---
    $('#managerIdInput').oninput = e => { state.managerId=e.target.value; localStorage.setItem('mgrId', e.target.value); };
    $('#open-asset-modal-new').onclick = openNewAssetModal; 
    $('#close-asset-modal').onclick = closeAssetModal; 
    $('#asset-form').onsubmit = handleAssetFormSubmit; 
    
    $('#asset-list').addEventListener('click', (e) => {
        const card = e.target.closest('.asset-card');
        if (!card) return;

        if (e.target.classList.contains('asset-select-checkbox')) {
            const cmf2 = e.target.getAttribute('data-cmf2');
            if (e.target.checked) {
                state.selectedAssets.add(cmf2);
            } else {
                state.selectedAssets.delete(cmf2);
            }
            updateBulkPrintButton(); 
            return; 
        }

        if (e.target.closest('.reissue-label-btn')) {
            return;
        }
        
        const cmf2 = card.getAttribute('data-cmf2');
        if (cmf2) { 
            openEditAssetModal(cmf2); 
        }
    });
    
    // --- 자산 검색 및 필터 이벤트 ---
    $('#asset-search-input').oninput = filterAndRenderAssets;
    $('#asset-filter-type').onchange = filterAndRenderAssets;
    
    // --- [신규] 횟수 수명 관리 검색/필터 이벤트 ---
    $('#lifecycle-search-input').oninput = filterAndRenderLifecycle;
    $('#lifecycle-filter-type').onchange = filterAndRenderLifecycle;

    // --- 소모/반환 폼 이벤트 ---
    $('#consumption-form').onsubmit = saveConsumption;
    $('#cons-pcode').onchange = handleProductChange;
    $('#cons-serial').onchange = handleSerialChange;
    
    // --- 수명 관리 이벤트 ---
    $('#lifecycle-type').onchange = (e) => {
        const valInput = $('#lifecycle-value');
        if (e.target.value === 'NONE') { 
            valInput.disabled = true; valInput.value = ''; 
            valInput.classList.add('bg-gray-200', 'cursor-not-allowed');
            valInput.classList.remove('bg-white');
        } else { 
            valInput.disabled = false; 
            valInput.classList.remove('bg-gray-200', 'cursor-not-allowed');
            valInput.classList.add('bg-white');
            valInput.focus(); 
        }
    };
    
    $('#lifecycle-list').addEventListener('click', async (e) => {
        const button = e.target.closest('.use-btn'); 
        if (button) {
            const pCode = button.getAttribute('data-pcode');
            const sn = button.getAttribute('data-sn');
            const qty = parseInt(button.getAttribute('data-qty') || '1'); 
            await handleUseAsset(pCode, sn, qty); 
        }
    });
    
    // --- 스캐너/OCR 이벤트 ---
    $('#open-scanner-btn-product').onclick = () => {
        scannerTargetInput = document.querySelector('#asset-form input[name="product_code"]');
        startQrScanner();
    };
    $('#open-scanner-btn-serial').onclick = () => {
        scannerTargetInput = document.querySelector('#asset-form input[name="serial_number"]');
        startQrScanner();
    };
    $('#close-scanner-btn').onclick = () => stopQrScanner();

    $('#open-ocr-btn-product').onclick = () => {
        ocrTargetInput = document.querySelector('#asset-form input[name="product_code"]');
        $('#ocr-file-input').click(); 
    };
    $('#open-ocr-btn-serial').onclick = () => {
        ocrTargetInput = document.querySelector('#asset-form input[name="serial_number"]');
        $('#ocr-file-input').click(); 
    };
    
    $('#ocr-file-input').onchange = (e) => handleOcrImage(e);

    // --- 라벨 모달 이벤트 ---
    $('#close-label-modal').onclick = () => {
        $('#label-modal').classList.add('hidden');
        $('#label-qrcode').innerHTML = ''; 
    };
    $('#print-label-btn').onclick = () => {
        window.print(); 
    };

    $('#asset-list').addEventListener('click', (e) => {
        const button = e.target.closest('.reissue-label-btn');
        if (button) {
            e.stopPropagation(); 
            const cmf2 = button.getAttribute('data-cmf2');
            if (cmf2) {
                showLabelModal(cmf2); 
            } else {
                alertMsg('이 자산에는 관리 코드가 없어 라벨을 재발행할 수 없습니다.');
            }
        }
    });

    // --- 일괄 라벨 인쇄 모달 이벤트 ---
    $('#open-bulk-label-modal').onclick = openBulkLabelModal;
    $('#close-bulk-label-modal').onclick = () => $('#bulk-label-modal').classList.add('hidden');
    $('#print-bulk-label-btn').onclick = () => {
        const printWindow = window.open('', '_blank');
        const contentToPrint = $('#bulk-label-content-wrapper').innerHTML;
        const styles = Array.from(document.styleSheets)
            .map(s => s.href ? `<link rel="stylesheet" href="${s.href}">` : `<style>${Array.from(s.cssRules).map(r => r.cssText).join('')}</style>`)
            .join('');
        
        printWindow.document.write(`
            <html>
                <head>
                    <title>라벨 일괄 인쇄</title>
                    ${styles}
                    <style>
                        @media print {
                            body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                            #bulk-label-content { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
                        }
                    </style>
                </head>
                <body onload="window.print(); window.close();">
                    ${contentToPrint}
                </body>
            </html>
        `);
        printWindow.document.close();
    };
    $('#asset-select-all').onclick = toggleSelectAllAssets;


    // --- 부서/사용자 마스터 모달 이벤트 ---
    $('#open-dept-modal-new').onclick = () => openNewMasterModal('dept');
    $('#open-user-modal-new').onclick = () => openNewMasterModal('user');
    $('#close-dept-user-modal').onclick = closeDeptUserModal;
    $('#dept-user-form').onsubmit = handleDeptUserFormSubmit;

    $('#dept-table-body').addEventListener('click', e => {
        const editBtn = e.target.closest('.edit-btn');
        const deleteBtn = e.target.closest('.delete-btn');
        if (editBtn) {
            openEditMasterModal('dept', editBtn.getAttribute('data-id'));
        } else if (deleteBtn) {
            handleDeleteMaster('dept', deleteBtn.getAttribute('data-id'));
        }
    });

    $('#user-table-body').addEventListener('click', e => {
        const editBtn = e.target.closest('.edit-btn');
        const deleteBtn = e.target.closest('.delete-btn');
        if (editBtn) {
            openEditMasterModal('user', editBtn.getAttribute('data-id'));
        } else if (deleteBtn) {
            handleDeleteMaster('user', deleteBtn.getAttribute('data-id'));
        }
    });
    
    // --- [신규] 활동 로그 필터 이벤트 ---
    $('#audit-log-search-btn').onclick = loadAuditLogs;
}

function resetLifecycleInputs() {
     const valInput = $('#lifecycle-value');
     valInput.disabled = true; valInput.value = '';
     valInput.classList.add('bg-gray-200', 'cursor-not-allowed');
}

function changeView(id) {
    state.selectedAssets.clear();
    updateBulkPrintButton();
    destroyCharts(); 

    $$('.view-content').forEach(el => el.classList.add('hidden'));
    $('#'+id).classList.remove('hidden');
    
    $$('#sidebar ul button').forEach(btn => btn.classList.remove('bg-indigo-600'));
    $('#nav-'+id.replace('view-','')).classList.add('bg-indigo-600');
    
    if (id === 'view-dashboard') render(); 
    if (id === 'view-assets') renderAssets(); 
    if (id === 'view-consumption') updateConsumptionDropdowns();
    if (id === 'view-lifecycle') filterAndRenderLifecycle(); // [수정]
    if (id === 'view-departments') renderDepartments(); 
    if (id === 'view-users') renderUsers();
    if (id === 'view-audit-log') {
        const today = getISODate(new Date());
        $('#audit-log-start-date').value = today;
        $('#audit-log-end-date').value = today;
        populateAuditLogFilters(); 
        loadAuditLogs(); 
    }
}

async function loadData() {
    const [rMaster, rHistoryTop, rStock, rUseHistory, rDepts, rUsers] = await Promise.all([
        supabase.from('MA_PRODUCT').select('*').order('created_at', { ascending: false }),
        supabase.from('LOT_HIS').select('*').order('created_at', { ascending: false }).limit(20),
        supabase.from('WH_STS').select('*'),
        supabase.from('LOT_HIS').select('product_code, serial_number, qty').eq('tran_code', 'USE'),
        supabase.from('MA_DEPARTMENT').select('*').order('dept_name'), 
        supabase.from('MA_USER_P').select('*, MA_DEPARTMENT(dept_name)').order('user_name') 
    ]);

    if(rMaster.error) throw rMaster.error;
    if(rDepts.error) throw rDepts.error;
    if(rUsers.error) throw rUsers.error;
    
    state.assets = rMaster.data;
    state.history = rHistoryTop.data || [];
    state.stock = rStock.data || [];
    state.departments = rDepts.data || []; 
    state.users = rUsers.data || [];       

    state.usageCounts = {};
    if (rUseHistory.data) {
        rUseHistory.data.forEach(h => {
            const key = `${h.product_code}|${h.serial_number||'null'}`;
            state.usageCounts[key] = (state.usageCounts[key] || 0) + (h.qty || 0);
        });
    }
    render(); 
    
    populateAssetFilters();
    populateLifecycleFilters(); // [신규]
    populateAssetFormDropdowns();
}

function subscribe() {
    supabase.channel('public:all').on('postgres_changes', { event: '*', schema: 'public' }, 
        () => loadData().then(() => {
            
            state.selectedAssets.clear();
            updateBulkPrintButton();

            const currentView = $$('.view-content:not(.hidden)')[0];
            if (!currentView) return;
            
            switch(currentView.id) {
                case 'view-assets': renderAssets(); break;
                case 'view-departments': renderDepartments(); break;
                case 'view-users': renderUsers(); break;
                case 'view-audit-log': loadAuditLogs(); break;
                case 'view-lifecycle': filterAndRenderLifecycle(); break; // [신규]
            }
        })
    ).subscribe();
}

// =========================================
// 렌더링 함수들
// =========================================

function destroyCharts() {
    if (chartInstances.warehouse) {
        chartInstances.warehouse.destroy();
        chartInstances.warehouse = null;
    }
    if (chartInstances.type) {
        chartInstances.type.destroy();
        chartInstances.type = null;
    }
}

function render() {
    $('#kpi-total-assets').innerText = state.assets.length.toLocaleString();
    $('#kpi-total-stock').innerText = state.stock.reduce((sum, i) => sum + i.qty, 0).toLocaleString();
    
    destroyCharts(); 
    
    renderSafetyAlerts();       
    renderHistory();            
    renderDashboardHistory();   
    
    renderStockByWarehouseChart(); 
    renderTypeBreakdownChart();  
}

// ... (renderSafetyAlerts, renderDashboardHistory, renderHistory, getHistoryType - 변경 없음) ...
function renderSafetyAlerts() {
    const alerts = [];
    const today = new Date();
    state.stock.forEach(item => {
        const assetName = state.assets.find(a => a.product_code === item.product_code)?.product_name || item.product_code;
        const identifier = `${assetName} (${item.product_code})${item.serial_number ? ' [SN:'+item.serial_number+']' : ''}`;
        if (!item.cmf_3 || item.cmf_3 === 'NONE') {
            if (item.safe_qty > 0 && item.qty <= item.safe_qty) {
                alerts.push({ type: '📦 재고 부족', level: 'danger', msg: `<span class="font-bold">${identifier}</span>의 재고가 부족합니다. (현재: ${item.qty} / 안전: ${item.safe_qty})` });
            }
        } else if (item.cmf_3 === 'PERIOD') {
            const created = new Date(item.created_at);
            const monthsPassed = (today.getFullYear() - created.getFullYear()) * 12 + (today.getMonth() - created.getMonth());
            const limit = parseInt(item.cmf_4 || '0');
            if (limit > 0 && monthsPassed >= limit) {
                alerts.push({ type: '📅 교체 주기 도래', level: 'warning', msg: `<span class="font-bold">${identifier}</span>의 교체 주기가 되었습니다. (경과: ${monthsPassed}개월 / 주기: ${limit}개월)` });
            }
        } else if (item.cmf_3 === 'COUNT') {
            const key = `${item.product_code}|${item.serial_number||'null'}`;
            const used = state.usageCounts[key] || 0;
            const limit = parseInt(item.cmf_4 || '0');
            if (limit > 0 && used >= limit) {
                alerts.push({ type: '🔢 사용 한계 도달', level: 'warning', msg: `<span class="font-bold">${identifier}</span>의 사용 횟수가 한계에 도달했습니다. (사용: ${used}회 / 한계: ${limit}회)` });
            }
        }
    });
    $('#kpi-action-required').innerText = alerts.length.toLocaleString();
    const alertSection = $('#alert-section');
    const alertList = $('#alert-list');
    if (alerts.length === 0) {
        alertSection.classList.add('hidden');
    } else {
        alertSection.classList.remove('hidden');
        alertList.innerHTML = alerts.map(a => `
            <div class="flex items-start p-4 rounded-lg border-l-4 ${a.level === 'danger' ? 'bg-red-50 border-red-500 text-red-700' : 'bg-yellow-50 border-yellow-400 text-yellow-800'} shadow-sm">
                <div class="flex-shrink-0 font-bold mr-3">${a.type}</div>
                <div class="text-sm">${a.msg}</div>
            </div>`).join('');
    }
}

function renderDashboardHistory() {
    const tableBody = $('#dashboard-history-table');
    const history = state.history.slice(0, 5); 
    if (history.length === 0) { tableBody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-slate-500">최근 활동이 없습니다.</td></tr>'; return; }
    tableBody.innerHTML = history.map(h => {
        let { typeClass, typeName } = getHistoryType(h.tran_code);
        return `
        <tr class="hover:bg-slate-50 text-sm transition">
            <td class="p-3 font-bold ${typeClass}">${typeName}</td>
            <td class="p-3 font-mono">${h.product_code}</td>
            <td class="p-3 text-slate-500 font-mono">${h.serial_number||'-'}</td>
            <td class="p-3 font-bold text-right">${h.qty}</td>
            <td class="p-3 text-slate-400 text-xs">${new Date(h.created_at).toLocaleString().slice(2)}</td>
        </tr>`;
    }).join('');
}
        
function renderHistory() {
    const tableBody = $('#recent-lot-history-table');
    if (state.history.length === 0) { tableBody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-slate-500">이력이 없습니다.</td></tr>'; return; }
    tableBody.innerHTML = state.history.map(h => {
        let { typeClass, typeName } = getHistoryType(h.tran_code);
        return `
        <tr class="hover:bg-slate-50 text-sm transition">
            <td class="p-3 font-bold ${typeClass}">${typeName}</td>
            <td class="p-3 font-mono">${h.product_code}</td>
            <td class="p-3 text-slate-500 font-mono">${h.serial_number||'-'}</td>
            <td class="p-3 font-bold text-right">${h.qty}</td>
            <td class="p-3 text-slate-400 text-xs">${new Date(h.created_at).toLocaleString().slice(2)}</td>
        </tr>`;
    }).join('');
}

function getHistoryType(tranCode) {
    let typeClass = 'text-slate-600', typeName = tranCode;
    switch(tranCode) {
        case 'IN': typeName='입고'; typeClass='text-blue-600'; break;
        case 'CONSUME': typeName='소모'; typeClass='text-red-600'; break;
        case 'ROLLBACK': typeName='반환'; typeClass='text-green-600'; break;
        case 'USE': typeName='사용'; typeClass='text-purple-600'; break;
    }
    return { typeClass, typeName };
}

// =========================================
// [수정] 횟수 수명 관리 (필터/검색 추가)
// =========================================

/**
 * [신규] 횟수 수명 관리 탭의 필터/검색 메인 함수
 */
function filterAndRenderLifecycle() {
    const searchTerm = $('#lifecycle-search-input').value.trim().toLowerCase();
    const filterType = $('#lifecycle-filter-type').value;

    // 1. 'COUNT' 유형의 재고 항목만 필터링
    let filteredItems = state.stock.filter(s => s.cmf_3 === 'COUNT');

    // 2. 자산 유형(Type) 필터 적용 (state.assets에서 정보 조회)
    if (filterType) {
        filteredItems = filteredItems.filter(item => {
            const asset = state.assets.find(a => a.product_code === item.product_code);
            return asset && asset.product_type === filterType;
        });
    }

    // 3. 검색어(Search) 필터 적용 (제품코드, 시리얼, 관리번호)
    if (searchTerm) {
        filteredItems = filteredItems.filter(item => 
            (item.product_code && item.product_code.toLowerCase().includes(searchTerm)) ||
            (item.serial_number && item.serial_number.toLowerCase().includes(searchTerm)) ||
            (item.cmf_2 && item.cmf_2.toLowerCase().includes(searchTerm))
        );
    }

    // 4. 필터링된 결과로 카드 렌더링
    renderLifecycleCards(filteredItems);
}

/**
 * [수정] renderLifecycle -> renderLifecycleCards
 * 필터링된 횟수 관리 항목을 렌더링
 */
function renderLifecycleCards(itemsToRender) {
    const list = $('#lifecycle-list');
    
    if (itemsToRender.length === 0) {
        let message = "횟수(COUNT)로 관리되는 자산이 없습니다.";
        if (state.stock.filter(s => s.cmf_3 === 'COUNT').length > 0) {
            message = "검색/필터 조건에 맞는 자산이 없습니다.";
        }
        list.innerHTML = `<div class="col-span-full p-10 text-center text-slate-500 bg-slate-50 rounded-xl border border-dashed">${message}</div>`;
        return;
    }

    list.innerHTML = itemsToRender.map(item => {
        const asset = state.assets.find(a => a.product_code === item.product_code);
        const assetName = asset ? asset.product_name : item.product_code;
        const maxLife = parseInt(item.cmf_4 || '0');
        const currentUse = state.usageCounts[`${item.product_code}|${item.serial_number||'null'}`] || 0;
        const percent = maxLife > 0 ? Math.min((currentUse / maxLife) * 100, 100) : 0;
        let progressClass = '';
        if (percent >= 100) progressClass = 'danger';
        else if (percent >= 80) progressClass = 'warning';
        
        return `
        <div class="bg-white p-6 rounded-xl shadow border border-slate-200 flex flex-col justify-between">
            <div>
                <div class="flex justify-between items-start mb-2">
                    <h4 class="font-bold text-slate-800 truncate" title="${assetName}">${assetName}</h4>
                    <span class="px-2 py-1 text-xs rounded-full bg-blue-100 text-blue-800 whitespace-nowrap">횟수 관리</span>
                </div>
                <div class="text-sm text-slate-600 space-y-1 mb-4">
                     <p>코드: <span class="font-mono font-semibold">${item.product_code}</span></p>
                     <p>S/N: <span class="font-mono">${item.serial_number || '(No Serial)'}</span></p>
                     <p class="text-xs text-slate-400">관리번호: <span class="font-mono">${item.cmf_2 || '-'}</span></p>
                </div>
                <div class="mb-4">
                    <div class="flex justify-between text-xs font-semibold mb-1">
                        <span>현재 사용: ${currentUse}회</span>
                        <span class="text-slate-400">최대 수명: ${maxLife}회</span>
                    </div>
                    <progress class="${progressClass} h-3" value="${percent}" max="100"></progress>
                </div>
            </div>
            <div class="flex justify-between space-x-2 mt-4">
                <button class="use-btn w-full py-2 bg-indigo-50 text-indigo-700 font-semibold rounded-lg hover:bg-indigo-100 transition text-sm" 
                        data-pcode="${item.product_code}" data-sn="${item.serial_number||''}" data-qty="1">
                    + 1회
                </button>
                <button class="use-btn w-full py-2 bg-indigo-50 text-indigo-700 font-semibold rounded-lg hover:bg-indigo-100 transition text-sm" 
                        data-pcode="${item.product_code}" data-sn="${item.serial_number||''}" data-qty="10">
                    + 10회
                </button>
                <button class="use-btn w-full py-2 bg-indigo-50 text-indigo-700 font-semibold rounded-lg hover:bg-indigo-100 transition text-sm" 
                        data-pcode="${item.product_code}" data-sn="${item.serial_number||''}" data-qty="100">
                    + 100회
                </button>
            </div>
        </div>`;
    }).join('');
}


async function handleUseAsset(pCode, sn, qty) {
    if(!checkMgr()) return;
    const serialVal = sn === '' ? null : sn; 
    if(!confirm(`[ ${pCode} ] 자산을 ${qty}회 사용 처리하시겠습니까?`)) return;

    showLoading(true, '사용 처리 중...');
    try {
        const { error } = await supabase.from('LOT_HIS').insert({
            tran_code: 'USE', 
            product_code: pCode,
            serial_number: serialVal, 
            qty: qty, 
            create_user_id: state.managerId
        });
        if(error) throw error;
        
        await logAudit('TRANSACTION', 'LOT_HIS', pCode, `횟수 사용: ${qty}회 (S/N: ${serialVal || 'N/A'})`);

        alertMsg('사용 처리가 완료되었습니다.');
    } catch(e) { 
        alertMsg('처리 실패: ' + e.message, true); 
    } 
    finally { 
        showLoading(false); 
    }
}

// ... (updateConsumptionDropdowns ~ handleSerialChange - 변경 없음) ...
function updateConsumptionDropdowns() {
    const pSelect = $('#cons-pcode');
    const currentVal = pSelect.value;
    const uniqueCodes = [...new Set(state.stock.map(s => s.product_code))].sort();
    pSelect.innerHTML = '<option value="">자산 선택...</option>' + uniqueCodes.map(c => {
        const a = state.assets.find(ax => ax.product_code === c);
        return `<option value="${c}">${a ? a.product_name : c} (${c})</option>`;
    }).join('');
    if(currentVal && uniqueCodes.includes(currentVal)) pSelect.value = currentVal;
    handleProductChange();
}
function handleProductChange() {
    const pCode = $('#cons-pcode').value;
    const sSelect = $('#cons-serial');
    $('#cons-wh-code').value = '';
    sSelect.innerHTML = '<option value="">선택하세요</option>';
    if(!pCode) return;
    state.stock.filter(s => s.product_code === pCode).forEach(i => {
        const serialText = i.serial_number ? `S/N: ${i.serial_number}` : '(No Serial)';
        sSelect.innerHTML += `<option value="${i.serial_number||''}" data-wh="${i.wh_code}">${serialText} | 창고: ${i.wh_code} | 재고: ${i.qty}ea</option>`;
    });
}
function handleSerialChange(e) {
    $('#cons-wh-code').value = e.target.selectedOptions[0]?.getAttribute('data-wh') || '';
}


// =========================================
// 차트 렌더링 함수 (변경 없음)
// =========================================
function renderStockByWarehouseChart() {
    const container = $('#stock-by-warehouse-container');
    const ctx = $('#stock-by-warehouse-chart');
    if (!ctx) return;

    const whStock = state.stock.reduce((acc, item) => {
        const wh = item.wh_code || '미지정';
        acc[wh] = (acc[wh] || 0) + item.qty;
        return acc;
    }, {});

    if (Object.keys(whStock).length === 0) {
        container.innerHTML = '<canvas id="stock-by-warehouse-chart"></canvas><p class="text-sm text-slate-500">재고 정보가 없습니다.</p>'; return;
    }
    
    const sortedData = Object.entries(whStock).sort((a, b) => a[1] - b[1]);

    const labels = sortedData.map(item => item[0]);
    const data = sortedData.map(item => item[1]);

    chartInstances.warehouse = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: '재고 수량',
                data: data,
                backgroundColor: 'rgba(79, 70, 229, 0.8)', // indigo-600
                borderColor: 'rgba(79, 70, 229, 1)',
                borderWidth: 1
            }]
        },
        options: {
            indexAxis: 'y', 
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    display: false 
                }
            },
            scales: {
                x: {
                    beginAtZero: true
                }
            }
        }
    });
}

function renderTypeBreakdownChart() {
    const container = $('#type-breakdown-container');
    const ctx = $('#type-breakdown-chart');
    if (!ctx) return;

    const counts = state.assets.reduce((acc, cur) => { 
        const type = cur.product_type || '미지정';
        acc[type] = (acc[type]||0)+1; 
        return acc; 
    }, {});

    if (Object.keys(counts).length === 0) {
        container.innerHTML = '<canvas id="type-breakdown-chart"></canvas><p class="text-sm text-slate-500">자산 유형 정보가 없습니다.</p>'; return;
    }

    const labels = Object.keys(counts);
    const data = Object.values(counts);

    chartInstances.type = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                label: '자산 수량',
                data: data,
                backgroundColor: [
                    'rgba(79, 70, 229, 0.8)',  // indigo-600
                    'rgba(5, 150, 105, 0.8)',   // emerald-600
                    'rgba(217, 119, 6, 0.8)',  // amber-600
                    'rgba(220, 38, 38, 0.8)',  // red-600
                    'rgba(107, 114, 128, 0.8)', // gray-500
                    'rgba(59, 130, 246, 0.8)'  // blue-500
                ],
                hoverOffset: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'right', 
                }
            }
        }
    });
}

// =========================================
// 부서/사용자 렌더링 (변경 없음)
// =========================================
function renderDepartments() {
    const tableBody = $('#dept-table-body');
    if (state.departments.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="4" class="p-4 text-center text-slate-500">등록된 부서가 없습니다.</td></tr>';
        return;
    }
    tableBody.innerHTML = state.departments.map(dept => `
        <tr class="hover:bg-slate-50 text-sm">
            <td class="p-3 font-mono font-semibold">${dept.dept_code}</td>
            <td class="p-3">${dept.dept_name}</td>
            <td class="p-3 text-slate-400 text-xs">${new Date(dept.created_at).toLocaleDateString()}</td>
            <td class="p-3 text-right">
                <button class="edit-btn text-blue-600 hover:text-blue-800 font-medium mr-3" data-id="${dept.dept_code}">수정</button>
                <button class="delete-btn text-red-600 hover:text-red-800 font-medium" data-id="${dept.dept_code}">삭제</button>
            </td>
        </tr>
    `).join('');
}

function renderUsers() {
    const tableBody = $('#user-table-body');
    if (state.users.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="4" class="p-4 text-center text-slate-500">등록된 사용자가 없습니다.</td></tr>';
        return;
    }
    tableBody.innerHTML = state.users.map(user => `
        <tr class="hover:bg-slate-50 text-sm">
            <td class="p-3 font-mono font-semibold">${user.user_id}</td>
            <td class="p-3">${user.user_name}</td>
            <td class="p-3 text-slate-500">${user.MA_DEPARTMENT?.dept_name || (user.dept_code ? `(${user.dept_code})` : '소속 없음')}</td>
            <td class="p-3 text-right">
                <button class="edit-btn text-blue-600 hover:text-blue-800 font-medium mr-3" data-id="${user.user_id}">수정</button>
                <button class="delete-btn text-red-600 hover:text-red-800 font-medium" data-id="${user.user_id}">삭제</button>
            </td>
        </tr>
    `).join('');
}

// =========================================
// 드롭다운 채우기
// =========================================
function populateAssetFormDropdowns() {
    const deptSelectAsset = $('#asset-form-dept');
    const userSelectAsset = $('#asset-form-user');
    const deptSelectUserForm = $('#dept-user-form-dept-select');
    
    const currentDept = deptSelectAsset.value;
    const currentUser = userSelectAsset.value;
    const currentDeptUser = deptSelectUserForm.value;

    const deptOptions = state.departments.map(d => `<option value="${d.dept_code}">${d.dept_name} (${d.dept_code})</option>`).join('');
    const userOptions = state.users.map(u => `<option value="${u.user_id}">${u.user_name} (${u.user_id})</option>`).join('');

    deptSelectAsset.innerHTML = '<option value="">부서 선택...</option>' + deptOptions;
    userSelectAsset.innerHTML = '<option value="">사용자 선택 안함</option>' + userOptions;
    deptSelectUserForm.innerHTML = '<option value="">소속 없음</option>' + deptOptions;
    
    if (currentDept) deptSelectAsset.value = currentDept;
    if (currentUser) userSelectAsset.value = currentUser;
    if (currentDeptUser) deptSelectUserForm.value = currentDeptUser;
}

// =========================================
// 자산 검색/필터 함수 (변경 없음)
// =========================================
function populateAssetFilters() {
    const filterSelect = $('#asset-filter-type');
    const currentVal = filterSelect.value; 
    
    const typesFromMap = Object.keys(TYPE_MAP);
    const typesFromState = state.assets.map(a => a.product_type);
    
    const types = [...new Set([...typesFromMap, ...typesFromState])]
                    .filter(t => t) 
                    .sort();
    
    filterSelect.innerHTML = '<option value="">모든 유형</option>'; 
    
    types.forEach(type => {
        filterSelect.innerHTML += `<option value="${type}">${type}</option>`;
    });
    
    filterSelect.value = currentVal; 
}

/**
 * [신규] 횟수 수명 관리 탭의 필터 드롭다운을 채웁니다.
 */
function populateLifecycleFilters() {
    const filterSelect = $('#lifecycle-filter-type');
    const currentVal = filterSelect.value; 
    
    const typesFromMap = Object.keys(TYPE_MAP);
    // 'COUNT' 관리 대상 자산의 유형만 추림
    const countItemCodes = state.stock.filter(s => s.cmf_3 === 'COUNT').map(s => s.product_code);
    const typesFromState = state.assets
        .filter(a => countItemCodes.includes(a.product_code))
        .map(a => a.product_type);
    
    const types = [...new Set([...typesFromMap, ...typesFromState])]
                    .filter(t => t) 
                    .sort();
    
    filterSelect.innerHTML = '<option value="">모든 유형</option>'; 
    
    types.forEach(type => {
        filterSelect.innerHTML += `<option value="${type}">${type}</option>`;
    });
    
    filterSelect.value = currentVal; 
}


function filterAndRenderAssets() {
    const searchTerm = $('#asset-search-input').value.trim().toLowerCase();
    const filterType = $('#asset-filter-type').value;
    
    let filteredAssets = state.assets;

    if (searchTerm) {
        filteredAssets = filteredAssets.filter(a => 
            (a.product_name && a.product_name.toLowerCase().includes(searchTerm)) ||
            (a.product_code && a.product_code.toLowerCase().includes(searchTerm)) ||
            (a.cmf_2 && a.cmf_2.toLowerCase().includes(searchTerm)) 
        );
    }

    if (filterType) {
        filteredAssets = filteredAssets.filter(a => a.product_type === filterType);
    }

    renderAssetCards(filteredAssets);
}

function renderAssetCards(assetsToRender) {
    const list = $('#asset-list');
    
    if (assetsToRender.length === 0) {
        let message = '등록된 자산 마스터가 없습니다.';
        if (state.assets.length > 0) {
            message = '검색/필터 조건에 맞는 자산이 없습니다.';
        }
        list.innerHTML = `<div class="col-span-full p-10 text-center bg-white rounded-xl text-slate-500 border border-dashed">${message}</div>`;
        return;
    }
    
    list.innerHTML = assetsToRender.map(a => {
        const cmf2 = a.cmf_2 || '';
        const isChecked = state.selectedAssets.has(cmf2);

        return `
        <div class="asset-card bg-white p-5 rounded-xl shadow-sm hover:shadow-lg hover:ring-2 hover:ring-indigo-400 cursor-pointer transition border border-slate-200"
             data-cmf2="${cmf2}">
            
            <div class="flex justify-between items-start mb-3">
                <h3 class="font-bold text-slate-800 truncate pr-2" title="${a.product_name}">${a.product_name}</h3>
                
                <input type="checkbox" 
                       class="asset-select-checkbox flex-shrink-0 h-5 w-5 ml-2" 
                       data-cmf2="${cmf2}"
                       ${!cmf2 ? 'disabled title="관리 코드 없음"' : 'title="선택"'} 
                       ${isChecked ? 'checked' : ''}>
            </div>

            <div class="text-sm text-slate-600 space-y-1">
                <p>코드: <span class="font-mono font-semibold">${a.product_code}</span></p>
                <p class="text-xs text-slate-400">관리번호: <span class="font-mono">${cmf2 || '-'}</span></p>
                <div class="flex justify-between items-center mt-3 pt-3 border-t">
                    <span class="text-xs text-slate-500">
                        ${a.cmf_3==='PERIOD' ? '📅 주기: '+a.cmf_4+'개월' : (a.cmf_3==='COUNT' ? '🔢 수명: '+a.cmf_4+'회' : '📦 일반 관리')}
                    </span>
                    <span class="font-bold text-indigo-600">${a.qty} ${a.unit}</span>
                </div>
                
                <button 
                    class="reissue-label-btn w-full text-center px-4 py-2 mt-4 bg-slate-100 text-slate-700 font-semibold rounded-lg hover:bg-slate-200 transition text-sm ${!cmf2 ? 'opacity-50 cursor-not-allowed' : ''}" 
                    data-cmf2="${cmf2}"
                    ${!cmf2 ? 'disabled' : ''}
                >
                    🖨️ 라벨 재발행
                </button>
            </div>
        </div>`;
    }).join('');
}

function renderAssets() {
    filterAndRenderAssets();
}


// =========================================
// 활동 로그(Audit Log) 관련 함수 (신규)
// =========================================
/**
 * 활동 로그의 사용자 필터 드롭다운을 채웁니다.
 */
function populateAuditLogFilters() {
    const userFilter = $('#audit-log-user-filter');
    if (!userFilter) return; // 뷰가 아직 로드되지 않았을 수 있음
    
    const currentVal = userFilter.value;
    
    const userIds = new Set(state.users.map(u => u.user_id));
    if (state.managerId) userIds.add(state.managerId);
    
    const sortedUserIds = [...userIds].sort();
    
    userFilter.innerHTML = '<option value="">모든 사용자</option>';
    sortedUserIds.forEach(id => {
        if (!id) return;
        const user = state.users.find(u => u.user_id === id);
        const name = user ? user.user_name : '알 수 없음';
        userFilter.innerHTML += `<option value="${id}">${name} (${id})</option>`;
    });
    
    userFilter.value = currentVal;
}

/**
 * 활동 로그를 필터링하여 불러옵니다.
 */
async function loadAuditLogs() {
    const userId = $('#audit-log-user-filter').value;
    let startDate = $('#audit-log-start-date').value;
    let endDate = $('#audit-log-end-date').value;

    if (!startDate || !endDate) {
        alertMsg('조회 시작일과 종료일을 모두 선택해주세요.');
        return;
    }
    
    endDate = `${endDate}T23:59:59`;
    startDate = `${startDate}T00:00:00`;

    showLoading(true, '로그 조회 중...');
    try {
        let query = supabase.from('AUDIT_LOG').select('*')
            .gte('created_at', startDate)
            .lte('created_at', endDate)
            .order('created_at', { ascending: false })
            .limit(200); 

        if (userId) {
            query = query.eq('user_id', userId);
        }

        const { data, error } = await query;
        if (error) throw error;

        state.auditLogs = data;
        renderAuditLog();

    } catch (e) {
        alertMsg('로그 조회 실패: ' + e.message, true);
    } finally {
        showLoading(false);
    }
}

/**
 * 활동 로그 테이블을 렌더링합니다.
 */
function renderAuditLog() {
    const tableBody = $('#audit-log-table-body');
    if (state.auditLogs.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-slate-500">해당 조건의 활동 로그가 없습니다.</td></tr>';
        return;
    }
    tableBody.innerHTML = state.auditLogs.map(log => {
        let actionClass = '';
        switch(log.action_type) {
            case 'CREATE': actionClass = 'text-green-600'; break;
            case 'UPDATE': actionClass = 'text-blue-600'; break;
            case 'DELETE': actionClass = 'text-red-600'; break;
            case 'TRANSACTION': actionClass = 'text-purple-600'; break;
        }
        
        return `
            <tr class="hover:bg-slate-50 text-sm">
                <td class="p-3 text-slate-400 text-xs">${new Date(log.created_at).toLocaleString()}</td>
                <td class="p-3 font-semibold">${log.user_id}</td>
                <td class="p-3 font-bold ${actionClass}">${log.action_type}</td>
                <td class="p-3 font-mono text-xs">${log.target_table}<br>(${log.target_id || 'N/A'})</td>
                <td class="p-3 text-slate-600">${log.details}</td>
            </tr>
        `;
    }).join('');
}


// =========================================
// 라벨/스캐너/OCR 로직 (변경 없음)
// =========================================
function showLabelModal(cmf2_code) {
    if (!cmf2_code) return;

    const qrCodeElement = $('#label-qrcode');
    const cmf2TextElement = $('#label-cmf2-text');

    cmf2TextElement.innerText = cmf2_code;
    qrCodeElement.innerHTML = ''; 
    
    try {
        qrCodeInstance = new QRCode(qrCodeElement, {
            text: cmf2_code,
            width: 100,
            height: 100,
            colorDark : "#000000",
            colorLight : "#ffffff",
            correctLevel : QRCode.CorrectLevel.H
        });
    } catch (e) {
        console.error("QR 코드 생성 실패:", e);
        qrCodeElement.innerText = "QR 생성 오류";
    }
    
    $('#label-modal').classList.remove('hidden'); 
}

function onScanSuccess(decodedText, decodedResult) {
    if (scannerTargetInput) {
        scannerTargetInput.value = decodedText; 
        alertMsg('스캔된 값이 입력되었습니다.');
    } else {
        console.warn('스캔 대상(Target)이 지정되지 않았습니다.');
    }
    stopQrScanner();
}

function startQrScanner() {
    if (!scannerTargetInput) {
        alertMsg('스캔할 필드를 먼저 선택해주세요 (버튼 클릭 오류).', true);
        return;
    }
    
    $('#scanner-modal').classList.remove('hidden');

    if (!html5QrCodeScanner || html5QrCodeScanner.getState() === 1) { // 1 = NOT_STARTED
        
        const scannerConfig = {
            fps: 10, 
            qrbox: (viewfinderWidth, viewfinderHeight) => {
                const size = Math.min(viewfinderWidth, viewfinderHeight) * 0.6; // 60%
                return { width: size, height: size };
            },
            formatsToSupport: [
                window.Html5QrcodeSupportedFormats.QR_CODE,
                window.Html5QrcodeSupportedFormats.CODE_128,
                window.Html5QrcodeSupportedFormats.CODE_39,
                window.Html5QrcodeSupportedFormats.EAN_13,
                window.Html5QrcodeSupportedFormats.UPC_A
            ],
            camera: { 
                facingMode: "environment" 
            }
        };

        html5QrCodeScanner = new Html5QrcodeScanner(
            "qr-reader", 
            scannerConfig, 
            /* verbose= */ false
        );
    }
    
    html5QrCodeScanner.render(onScanSuccess, (error) => {
        // 오류 무시
    });
}

function stopQrScanner() {
    if (html5QrCodeScanner && html5QrCodeScanner.getState() !== 1) { // 1 = NOT_STARTED
        try {
            html5QrCodeScanner.stop().then(() => {
                console.log("스캐너 중지됨.");
                html5QrCodeScanner.clear(); 
            }).catch(err => {
                console.warn("스캐너 중지 오류:", err);
                html5QrCodeScanner.clear(); 
            });
        } catch (e) {
            console.error("스캐너 중지 실패:", e);
        }
    }
    $('#scanner-modal').classList.add('hidden');
    scannerTargetInput = null; 
}

async function handleOcrImage(e) {
    const file = e.target.files[0];
    if (!file || !ocrTargetInput) {
        e.target.value = null; 
        return;
    }

    showLoading(true, '텍스트 인식 중... (최대 1분)'); 

    try {
        const { data: { text } } = await Tesseract.recognize(
            file,
            'eng', 
            { logger: m => console.log(m.status, m.progress) } 
        );
        
        const cleanText = text.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, " ").trim();
        
        if (cleanText) {
            ocrTargetInput.value = cleanText;
            alertMsg('텍스트 인식이 완료되었습니다. 필요한 부분만 남기고 수정해주세요.');
        } else {
            alertMsg('사진에서 텍스트를 찾지 못했습니다.', true);
        }

    } catch (err) {
        console.error('OCR Error:', err);
        alertMsg('텍스트 인식 중 오류가 발생했습니다.', true);
    } finally {
        showLoading(false); 
        e.target.value = null; 
        ocrTargetInput = null; 
    }
}


// =========================================
// 일괄 인쇄 관련 함수 (변경 없음)
// =========================================
function updateBulkPrintButton() {
    const btn = $('#open-bulk-label-modal');
    const count = state.selectedAssets.size;
    
    btn.innerText = `🖨️ 선택 라벨 인쇄 (${count})`;
    
    if (count > 0) {
        btn.disabled = false;
        btn.classList.remove('opacity-50', 'cursor-not-allowed');
    } else {
        btn.disabled = true;
        btn.classList.add('opacity-50', 'cursor-not-allowed');
    }
}

function toggleSelectAllAssets() {
    const checkboxes = $$('.asset-select-checkbox:not(:disabled)');
    const allSelected = checkboxes.length > 0 && [...checkboxes].every(cb => cb.checked);

    checkboxes.forEach(cb => {
        const cmf2 = cb.getAttribute('data-cmf2');
        if (allSelected) {
            cb.checked = false;
            state.selectedAssets.delete(cmf2);
        } else {
            cb.checked = true;
            state.selectedAssets.add(cmf2);
        }
    });
    updateBulkPrintButton();
}

function openBulkLabelModal() {
    if (state.selectedAssets.size === 0) {
        alertMsg('먼저 인쇄할 자산을 선택해주세요.');
        return;
    }
    
    const assetsToPrint = state.assets.filter(a => state.selectedAssets.has(a.cmf_2));

    renderBulkLabels(assetsToPrint);
    $('#bulk-label-modal').classList.remove('hidden');
}

function renderBulkLabels(assets) {
    const container = $('#bulk-label-content');
    container.innerHTML = ''; 
    
    let qrInstances = []; 

    assets.forEach((asset, index) => {
        const qrId = `bulk-qr-${index}`;
        container.innerHTML += `
            <div class="bulk-label-item">
                <img src="logo_NBTS.gif" alt="Logo">
                <div id="${qrId}" class="qr-code"></div>
                <p class="cmf-text">${asset.cmf_2}</p>
                <p class="warning-text">경고: 훼손 주의</p>
            </div>
        `;
        qrInstances.push({ id: qrId, text: asset.cmf_2 });
    });
    
    setTimeout(() => {
        qrInstances.forEach(qr => {
            try {
                new QRCode(document.getElementById(qr.id), {
                    text: qr.text,
                    width: 60,
                    height: 60,
                    colorDark : "#000000",
                    colorLight : "#ffffff",
                    correctLevel : QRCode.CorrectLevel.H
                });
            } catch(e) {
                console.error(`QR 생성 실패 (ID: ${qr.id}):`, e);
            }
        });
    }, 0);
}


// =========================================
// 부서/사용자 마스터 CRUD 함수 (로그 기록 추가)
// =========================================
function openNewMasterModal(type) {
    const form = $('#dept-user-form');
    form.reset();
    $('[name="master_type"]').value = type;
    $('[name="edit_id"]').value = '';
    
    const input1 = $('#input-field1');
    input1.readOnly = false;
    input1.disabled = false;
    input1.classList.remove('bg-gray-100', 'cursor-not-allowed');

    if (type === 'dept') {
        $('#dept-user-modal-title').innerText = '새 부서 등록';
        $('#label-field1').innerText = '부서 코드 *';
        input1.placeholder = '예: ICT';
        $('#label-field2').innerText = '부서명 *';
        $('#input-field2').placeholder = '예: ICT 기획팀';
        $('#user-dept-select-group').classList.add('hidden');
    } else {
        $('#dept-user-modal-title').innerText = '새 사용자 등록';
        $('#label-field1').innerText = '사용자 ID *';
        input1.placeholder = '예: hong.gd';
        $('#label-field2').innerText = '사용자명 *';
        $('#input-field2').placeholder = '예: 홍길동';
        $('#user-dept-select-group').classList.remove('hidden');
    }
    
    $('#dept-user-modal').classList.remove('hidden');
}

function openEditMasterModal(type, id) {
    const form = $('#dept-user-form');
    form.reset();
    $('[name="master_type"]').value = type;
    $('[name="edit_id"]').value = id;
    
    const input1 = $('#input-field1');
    input1.readOnly = true; 
    input1.disabled = true;
    input1.classList.add('bg-gray-100', 'cursor-not-allowed');

    if (type === 'dept') {
        const item = state.departments.find(d => d.dept_code === id);
        if (!item) return alertMsg('부서 정보를 찾을 수 없습니다.', true);
        
        $('#dept-user-modal-title').innerText = '부서 정보 수정';
        $('#label-field1').innerText = '부서 코드';
        $('#label-field2').innerText = '부서명 *';
        input1.value = item.dept_code;
        $('#input-field2').value = item.dept_name;
        $('#user-dept-select-group').classList.add('hidden');
        
    } else {
        const item = state.users.find(u => u.user_id === id);
        if (!item) return alertMsg('사용자 정보를 찾을 수 없습니다.', true);

        $('#dept-user-modal-title').innerText = '사용자 정보 수정';
        $('#label-field1').innerText = '사용자 ID';
        $('#label-field2').innerText = '사용자명 *';
        input1.value = item.user_id;
        $('#input-field2').value = item.user_name;
        $('#user-dept-select-group').classList.remove('hidden');
        $('#dept-user-form-dept-select').value = item.dept_code || '';
    }
    
    $('#dept-user-modal').classList.remove('hidden');
}

function closeDeptUserModal() {
    $('#dept-user-modal').classList.add('hidden');
    $('#dept-user-form').reset();
}

async function handleDeptUserFormSubmit(e) {
    e.preventDefault();
    if (!checkMgr()) return;

    const fd = new FormData(e.target);
    const type = fd.get('master_type');
    const editId = fd.get('edit_id');
    
    let tableName = '';
    let dataToSave = {};
    let idColumn = '';
    let typeName = '';
    let name = '';

    try {
        if (type === 'dept') {
            tableName = 'MA_DEPARTMENT';
            idColumn = 'dept_code';
            name = fd.get('field2');
            typeName = '부서';
            dataToSave = {
                dept_code: fd.get('field1'),
                dept_name: name
            };
        } else { // 'user'
            tableName = 'MA_USER_P';
            idColumn = 'user_id';
            name = fd.get('field2');
            typeName = '사용자';
            dataToSave = {
                user_id: fd.get('field1'),
                user_name: name,
                dept_code: fd.get('user_dept_code') || null
            };
        }

        showLoading(true, '저장 중...');

        let query;
        if (editId) {
            delete dataToSave[idColumn]; 
            query = supabase.from(tableName).update(dataToSave).eq(idColumn, editId);
            
            // [신규] 로그 기록
            await logAudit('UPDATE', tableName, editId, `${typeName} '${name}' 정보 수정`);
        } else {
            const newId = dataToSave[idColumn];
            query = supabase.from(tableName).insert(dataToSave);

            // [신규] 로그 기록
            await logAudit('CREATE', tableName, newId, `새 ${typeName} '${name}' 등록`);
        }

        const { error } = await query;
        if (error) throw error;

        alertMsg('성공적으로 저장되었습니다.');
        closeDeptUserModal();

    } catch (e) {
        alertMsg(`저장 실패: ${e.message}`, true);
    } finally {
        showLoading(false);
    }
}

async function handleDeleteMaster(type, id) {
    const typeName = (type === 'dept') ? '부서' : '사용자';
    const idColumn = (type === 'dept') ? 'dept_code' : 'user_id';
    const tableName = (type === 'dept') ? 'MA_DEPARTMENT' : 'MA_USER_P';
    
    const item = (type === 'dept') ? state.departments.find(d => d.dept_code === id) : state.users.find(u => u.user_id === id);
    const itemName = item ? (item.dept_name || item.user_name) : id;

    if (!confirm(`[${id}] ${typeName} 항목을 정말 삭제하시겠습니까?\n(주의: 이 작업은 되돌릴 수 없습니다.)`)) {
        return;
    }

    if (type === 'dept') {
        const usersInDept = state.users.filter(u => u.dept_code === id);
        if (usersInDept.length > 0) {
            alertMsg(`삭제 실패: [${usersInDept[0].user_name}]님 등 ${usersInDept.length}명의 사용자가 이 부서에 소속되어 있습니다.\n사용자들의 소속을 먼저 변경해주세요.`, true);
            return;
        }
    }

    showLoading(true, '삭제 중...');
    try {
        const { error } = await supabase.from(tableName).delete().eq(idColumn, id);
        if (error) throw error;
        
        // [신규] 로그 기록
        await logAudit('DELETE', tableName, id, `${typeName} '${itemName}' (${id}) 삭제`);

        alertMsg('성공적으로 삭제되었습니다.');

    } catch (e) {
        alertMsg(`삭제 실패: ${e.message}`, true);
    } finally {
        showLoading(false);
    }
}

// =========================================
// 자산 모달 관리 함수들 (로그 기록 추가)
// =========================================
function toggleAssetFormReadOnly(isEditMode) {
    const fieldsToDisable = ['product_code', 'factory_id', 'wh_code', 'qty', 'serial_number'];
    
    fieldsToDisable.forEach(name => {
        const input = $(`#asset-form [name="${name}"]`);
        if (input) {
            input.readOnly = isEditMode;
            input.disabled = isEditMode; 
            input.classList.toggle('bg-gray-100', isEditMode);
            input.classList.toggle('text-slate-500', isEditMode);
            input.classList.toggle('cursor-not-allowed', isEditMode);
        }
    });

    $$('#open-scanner-btn-product, #open-ocr-btn-product, #open-scanner-btn-serial, #open-ocr-btn-serial').forEach(btn => {
        btn.disabled = isEditMode;
        btn.classList.toggle('opacity-50', isEditMode);
        btn.classList.toggle('cursor-not-allowed', isEditMode);
    });
}

function openNewAssetModal() {
    $('#asset-form').reset();
    resetLifecycleInputs(); 
    $('#asset-modal-title').innerText = '새 자산 등록';
    $('#asset-modal-submit-btn').innerText = '저장 하기';
    $('#edit-id').value = '';
    toggleAssetFormReadOnly(false); 
    $('#asset-modal').classList.remove('hidden');
}

async function openEditAssetModal(cmf2) {
    const asset = state.assets.find(a => a.cmf_2 === cmf2);
    const stockItem = state.stock.find(s => s.cmf_2 === cmf2);

    if (!asset || !stockItem) {
        alertMsg('자산 상세 정보를 찾는 데 실패했습니다. (Master 또는 Stock 정보 누락)', true);
        return;
    }

    $('#asset-form').reset();
    
    $('[name="factory_id"]').value = stockItem.factory_id;
    $('[name="wh_code"]').value = stockItem.wh_code;
    $('[name="dept_code"]').value = stockItem.dept; 
    $('[name="user_id"]').value = stockItem.user || ''; 
    $('[name="serial_number"]').value = stockItem.serial_number || '';
    
    $('[name="product_name"]').value = asset.product_name;
    $('[name="product_code"]').value = asset.product_code;
    $('[name="purchase_date"]').value = asset.purchase_date;
    $('[name="cmf_1"]').value = asset.cmf_1;
    $('[name="product_type"]').value = asset.product_type;
    $('[name="cmf_3"]').value = asset.cmf_3 || 'NONE'; 
    $('[name="cmf_4"]').value = asset.cmf_4 || '';
    $('[name="qty"]').value = asset.qty; 
    $('[name="safe_qty"]').value = asset.safe_qty;
    $('[name="unit"]').value = asset.unit;
    $('[name="cmf_2"]').value = asset.cmf_2; 

    $('#lifecycle-type').dispatchEvent(new Event('change'));

    $('#asset-modal-title').innerText = '자산 정보 수정';
    $('#asset-modal-submit-btn').innerText = '수정 하기';
    $('#edit-id').value = cmf2; 
    toggleAssetFormReadOnly(true); 
    $('#asset-modal').classList.remove('hidden');
}

function closeAssetModal() {
    $('#asset-modal').classList.add('hidden');
    $('#asset-form').reset();
    resetLifecycleInputs();
    toggleAssetFormReadOnly(false); 
    $('#edit-id').value = '';
}

// =========================================
// 폼 저장 로직 (신규/수정 분기) (로그 기록 추가)
// =========================================
async function handleAssetFormSubmit(e) {
    e.preventDefault();
    if (!checkMgr()) return;

    const editId = $('#edit-id').value;

    if (editId) {
        await updateAsset(editId);
    } else {
        await saveAsset(e); 
    }
}

async function updateAsset(cmf2) {
    const fd = new FormData($('#asset-form'));
    
    const oldAsset = state.assets.find(a => a.cmf_2 === cmf2);
    const oldStock = state.stock.find(s => s.cmf_2 === cmf2);
    if (!oldAsset || !oldStock) return alertMsg('로그 기록 실패: 원본 데이터를 찾을 수 없습니다.', true);

    const lifeType = fd.get('cmf_3');
    const lifeVal = (lifeType === 'NONE') ? null : fd.get('cmf_4');

    const productMasterData = {
        product_name: fd.get('product_name'),
        purchase_date: fd.get('purchase_date'),
        cmf_1: fd.get('cmf_1'),
        product_type: fd.get('product_type'),
        safe_qty: parseInt(fd.get('safe_qty') || 0),
        unit: fd.get('unit'),
        cmf_3: lifeType,
        cmf_4: lifeVal
    };

    const stockData = {
        dept: fd.get('dept_code'), 
        user: fd.get('user_id') || null, 
        safe_qty: parseInt(fd.get('safe_qty') || 0),
        cmf_1: fd.get('cmf_1'),
        cmf_3: lifeType,
        cmf_4: lifeVal
    };

    showLoading(true, '자산 정보 업데이트 중...');
    try {
        const { error: e1 } = await supabase.from('MA_PRODUCT')
            .update(productMasterData)
            .eq('cmf_2', cmf2);
        if (e1) throw e1;

        const { error: e2 } = await supabase.from('WH_STS')
            .update(stockData)
            .eq('cmf_2', cmf2);
        if (e2) throw new Error('재고 정보 업데이트 실패: ' + e2.message);
        
        let changes = [];
        if (oldAsset.product_name !== productMasterData.product_name) changes.push('자산명');
        if (oldStock.dept !== stockData.dept) changes.push('부서');
        if (oldStock.user !== stockData.user) changes.push('사용자');
        if (oldAsset.safe_qty !== productMasterData.safe_qty) changes.push('안전재고');
        
        const details = changes.length > 0 ? 
            `자산 '${productMasterData.product_name}' 정보 수정: [${changes.join(', ')}]` :
            `자산 '${productMasterData.product_name}' 정보 확인/저장`;
            
        await logAudit('UPDATE', 'MA_PRODUCT', cmf2, details);

        alertMsg('자산 정보가 성공적으로 업데이트되었습니다.');
        closeAssetModal(); 
        
    } catch (e) {
        alertMsg('업데이트 실패: ' + e.message, true);
    } finally {
        showLoading(false);
    }
}

async function saveAsset(e) {
    const fd = new FormData(e.target);
    
    const pDate = new Date(fd.get('purchase_date'));
    const typeCode = TYPE_MAP[fd.get('product_type')] || 'ETC';
    const deptCode = fd.get('dept_code') || 'ETC'; 
    const dateCode = pDate.getFullYear().toString().slice(-2) + MONTH_MAP[pDate.getMonth()];
    const prefix = `${fd.get('cmf_1')}-${typeCode}-${deptCode}-${dateCode}`;
    
    let cmf_2 = ''; 

    showLoading(true, '자산 등록 중...');
    try {
        const { data: existing } = await supabase.from('MA_PRODUCT').select('cmf_2').ilike('cmf_2', `${prefix}-%`);
        let maxSeq = 0;
        (existing||[]).forEach(r => { try { maxSeq = Math.max(maxSeq, parseInt(r.cmf_2.split('-').pop())); } catch {} });
        
        cmf_2 = `${prefix}-${String(maxSeq+1).padStart(4,'0')}`; 
        
        const lifeType = fd.get('cmf_3');
        const lifeVal = (lifeType === 'NONE') ? null : fd.get('cmf_4');

        const productName = fd.get('product_name'); 

        const { error: e1 } = await supabase.from('MA_PRODUCT').insert({
            product_name: productName, product_code: fd.get('product_code'),
            product_type: fd.get('product_type'), cmf_1: fd.get('cmf_1'), cmf_2: cmf_2,
            purchase_date: fd.get('purchase_date'), qty: parseInt(fd.get('qty')||0),
            safe_qty: parseInt(fd.get('safe_qty')||0), unit: fd.get('unit'), create_user: state.managerId,
            cmf_3: lifeType, cmf_4: lifeVal
        });
        if(e1) throw e1;

        const { error: e2 } = await supabase.from('WH_STS').insert({
            factory_id: fd.get('factory_id'), wh_code: fd.get('wh_code'),
            product_code: fd.get('product_code'), qty: parseInt(fd.get('qty')||0),
            safe_qty: parseInt(fd.get('safe_qty')||0), serial_number: fd.get('serial_number') || null,
            dept: fd.get('dept_code'), 
            user: fd.get('user_id') || null, 
            cmf_1: fd.get('cmf_1'), cmf_2: cmf_2,
            cmf_3: lifeType, cmf_4: lifeVal
        });
        if(e2) throw new Error('재고 생성 실패: '+e2.message);

        await supabase.from('LOT_HIS').insert({ 
            tran_code: 'IN', product_code: fd.get('product_code'), 
            serial_number: fd.get('serial_number') || null, qty: parseInt(fd.get('qty')||0), 
            create_user_id: state.managerId 
        });
        
        await logAudit('CREATE', 'MA_PRODUCT', cmf_2, `새 자산 '${productName}' 등록`);

        alertMsg('자산 등록이 완료되었습니다.'); 

        showLabelModal(cmf_2); 
        
        $('#asset-modal').classList.add('hidden'); 
        e.target.reset(); 
        resetLifecycleInputs();
    } catch(e) { 
        alertMsg('저장 실패: '+e.message, true); 
    } finally { 
        showLoading(false); 
    }
}

// =========================================
// 소모/반환 로직 (로그 기록 추가)
// =========================================
async function saveConsumption(e) {
    e.preventDefault(); if(!checkMgr()) return;
    const fd = new FormData(e.target);
    const item = { pCode: fd.get('product_code'), sn: fd.get('serial_number') || null, wh: fd.get('wh_code'), qty: parseInt(fd.get('qty')), tran: fd.get('tran_code') };
    
    if(!item.pCode || !item.wh) { alertMsg('필수 정보가 누락되었습니다.'); return; }

    showLoading(true, '재고 처리 중...');
    try {
        let q = supabase.from('WH_STS').select('*').eq('product_code', item.pCode).eq('wh_code', item.wh);
        if(item.sn) q = q.eq('serial_number', item.sn); else q = q.is('serial_number', null);
        
        const { data: stock, error: err1 } = await q.single();
        if(err1 || !stock) throw new Error('해당 조건의 재고가 존재하지 않습니다.');
        
        const newQty = item.tran === 'CONSUME' ? stock.qty - item.qty : stock.qty + item.qty;
        if(newQty < 0) throw new Error(`재고가 부족합니다. (현재고: ${stock.qty})`);

        let uq = supabase.from('WH_STS').update({ qty: newQty }).eq('product_code', item.pCode).eq('wh_code', item.wh);
        if(item.sn) uq = uq.eq('serial_number', item.sn); else uq = uq.is('serial_number', null);
        const { error: e2 } = await uq; if(e2) throw e2;
        
        await supabase.from('LOT_HIS').insert({ 
            tran_code: item.tran, product_code: item.pCode, serial_number: item.sn, 
            qty: item.qty, create_user_id: state.managerId 
        });
        
        const tranName = item.tran === 'CONSUME' ? '소모(출고)' : '반환(입고)';
        await logAudit('TRANSACTION', 'WH_STS', item.pCode, `${tranName}: ${item.qty}개 (S/N: ${item.sn || 'N/A'})`);

        alertMsg('처리가 완료되었습니다.'); 
        e.target.reset(); $('#cons-serial').innerHTML = '<option value="">먼저 자산 코드를 선택하세요</option>';
    } catch(e) { alertMsg('처리 실패: '+e.message, true); } finally { showLoading(false); }
}

function checkMgr() { 
    if(!state.managerId) { 
        alertMsg('설정 탭에서 관리자 ID를 먼저 입력해주세요.'); 
        changeView('view-settings'); $('#managerIdInput').focus(); return false; 
    } return true; 
}

init();