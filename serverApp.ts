import express from 'express';
import path from 'path';
import fs from 'fs';
import { 
  INITIAL_TRACKS, 
  INITIAL_VEHICLES, 
  INITIAL_MOVEMENTS, 
  INITIAL_SCHEDULES, 
  INITIAL_USERS, 
  INITIAL_NOTIFICATIONS, 
  INITIAL_RULES, 
  INITIAL_AUDIT_LOGS 
} from './src/data/initialData';
import { 
  YardTrack, 
  TrainVehicle, 
  MovementRecord, 
  MaintenanceSchedule, 
  NotificationAlert, 
  NotificationRule, 
  AuditLogEntry, 
  DailyReportSummary,
  ActiveManobradorState,
  UserProfile
} from './src/types';


export function createExpressApp() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true, limit: '15mb' }));

  // CORS support for Netlify Functions / cross-origin
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

  // Netlify Functions path rewriting (handles /.netlify/functions/api, /api, or direct /v1)
  app.use((req, res, next) => {
    const originalUrl = (req.headers['x-original-url'] || req.headers['x-rewrite-url']) as string;
    if (originalUrl && originalUrl.startsWith('/api')) {
      req.url = originalUrl;
    } else if (req.url.startsWith('/.netlify/functions/api')) {
      req.url = req.url.replace('/.netlify/functions/api', '/api') || '/';
    } else if (req.url.startsWith('/.netlify/functions')) {
      req.url = req.url.replace('/.netlify/functions', '') || '/';
    }
    if (req.url.startsWith('/v1/')) {
      req.url = '/api' + req.url;
    }
    next();
  });

  // Continuous memory database files (supports local development and Netlify/AWS serverless environments)
  const isServerless = !!process.env.NETLIFY || !!process.env.AWS_LAMBDA_FUNCTION_NAME || !!process.env.LAMBDA_TASK_ROOT;
  const DATA_DIR = isServerless ? path.join('/tmp', 'data') : path.join(process.cwd(), 'data');
  const DB_FILE = path.join(DATA_DIR, 'yard_db.json');
  const USERS_FILE = path.join(DATA_DIR, 'users.json');

  if (isServerless) {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const seedUsers = path.join(process.cwd(), 'data', 'users.json');
      if (fs.existsSync(seedUsers) && !fs.existsSync(USERS_FILE)) {
        fs.copyFileSync(seedUsers, USERS_FILE);
      }
      const seedDb = path.join(process.cwd(), 'data', 'yard_db.json');
      if (fs.existsSync(seedDb) && !fs.existsSync(DB_FILE)) {
        fs.copyFileSync(seedDb, DB_FILE);
      }
    } catch (e) {
      // ignore in read-only environments
    }
  }

  // Memory state (seeded with initial data, then loaded from disk if exists)
  let tracks: YardTrack[] = JSON.parse(JSON.stringify(INITIAL_TRACKS));
  let vehicles: TrainVehicle[] = JSON.parse(JSON.stringify(INITIAL_VEHICLES));
  let movements: MovementRecord[] = JSON.parse(JSON.stringify(INITIAL_MOVEMENTS));
  let schedules: MaintenanceSchedule[] = JSON.parse(JSON.stringify(INITIAL_SCHEDULES));
  let notifications: NotificationAlert[] = JSON.parse(JSON.stringify(INITIAL_NOTIFICATIONS));
  let rules: NotificationRule[] = JSON.parse(JSON.stringify(INITIAL_RULES));
  let auditLogs: AuditLogEntry[] = JSON.parse(JSON.stringify(INITIAL_AUDIT_LOGS));
  let activeManobrador: ActiveManobradorState | null = null;
  let users: UserProfile[] = JSON.parse(JSON.stringify(INITIAL_USERS));

  function formatBadgeNumber(val: string): string {
    if (!val) return '38-';
    const digits = val.replace(/\D/g, '');
    if (!digits) return '38-';
    let cleanDigits = digits;
    if (!cleanDigits.startsWith('38')) {
      cleanDigits = '38' + cleanDigits;
    }
    const suffix = cleanDigits.slice(2, 9);
    return `38-${suffix}`;
  }

  function matchUserBadge(term: string, userBadge: string, userName?: string, userId?: string): boolean {
    if (!term) return false;
    const cleanTerm = term.toString().trim().toLowerCase();
    if (userId && userId.toLowerCase() === cleanTerm) return true;

    if (userBadge) {
      const cleanBadge = userBadge.toString().trim().toLowerCase();
      if (cleanTerm === cleanBadge) return true;

      const termDigits = cleanTerm.replace(/\D/g, '');
      const badgeDigits = cleanBadge.replace(/\D/g, '');

      if (termDigits.length > 0 && badgeDigits.length > 0) {
        if (termDigits === badgeDigits) return true;
        if (`38${termDigits}` === badgeDigits) return true;
        if (termDigits === `38${badgeDigits}`) return true;

        // Extract the numeric suffix after '38' prefix (or the entire digits if no 38 prefix)
        const termSuffix = termDigits.startsWith('38') && termDigits.length > 2
          ? termDigits.slice(2)
          : termDigits;
        const badgeSuffix = badgeDigits.startsWith('38') && badgeDigits.length > 2
          ? badgeDigits.slice(2)
          : badgeDigits;

        if (termSuffix && badgeSuffix) {
          if (termSuffix === badgeSuffix) return true;
          // Numerical matching ignoring leading zeros (e.g., "36" matches "38-00036" or "00036")
          const termNum = parseInt(termSuffix, 10);
          const badgeNum = parseInt(badgeSuffix, 10);
          if (!isNaN(termNum) && !isNaN(badgeNum) && termNum === badgeNum) return true;
        }
      }
    }

    if (userName) {
      const cleanName = userName.toString().trim().toLowerCase();
      if (cleanName === cleanTerm) return true;
      if (cleanTerm.length >= 3 && cleanName.includes(cleanTerm)) return true;
      const tokens = cleanName.split(/\s+/);
      if (tokens.some(t => t === cleanTerm || (cleanTerm.length >= 3 && t.startsWith(cleanTerm)))) {
        return true;
      }
    }

    return false;
  }

  function saveUsersToDisk() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const tmp = `${USERS_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(users, null, 2), 'utf-8');
      fs.renameSync(tmp, USERS_FILE);
      console.log(`[Storage] Base de operadores persistida com sucesso em ${USERS_FILE} (${users.length} operadores).`);
    } catch (e) {
      console.error('[Storage Error] Falha ao persistir usuários no disco:', e);
    }
  }

  function loadUsersFromDisk(): boolean {
    try {
      if (fs.existsSync(USERS_FILE)) {
        const raw = fs.readFileSync(USERS_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data) && data.length > 0) {
          const merged: UserProfile[] = [...data];
          for (const initUser of INITIAL_USERS) {
            if (!merged.some(u => matchUserBadge(initUser.badgeNumber, u.badgeNumber, undefined, u.id))) {
              merged.push(initUser);
            }
          }
          users = merged;
          console.log(`[Storage] Base de operadores carregada de ${USERS_FILE} (${users.length} operadores).`);
          return true;
        }
      }
    } catch (e) {
      console.error('[Storage Error] Falha ao carregar usuários de users.json:', e);
    }
    return false;
  }

  function parseDevice(userAgent: string | undefined, clientDevice?: string): { deviceString: string; deviceType: 'windows' | 'mobile' | 'other' } {
    if (clientDevice && clientDevice.trim().length > 0) {
      const isMob = /mobile|celular|android|ios|iphone|ipad/i.test(clientDevice);
      const isWin = /windows|pc/i.test(clientDevice);
      return {
        deviceString: clientDevice.trim(),
        deviceType: isMob ? 'mobile' : isWin ? 'windows' : 'other',
      };
    }
    const ua = userAgent || '';
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    const isWindows = /Windows/i.test(ua);
    const isMac = /Macintosh/i.test(ua);
    const isLinux = /Linux/i.test(ua) && !isMobile;
    
    let deviceString = 'Navegador Web';
    let deviceType: 'windows' | 'mobile' | 'other' = 'other';
    if (isMobile) {
      deviceType = 'mobile';
      if (/iPhone/i.test(ua)) deviceString = 'Mobile (Apple iPhone)';
      else if (/iPad/i.test(ua)) deviceString = 'Mobile (Apple iPad)';
      else if (/Android/i.test(ua)) deviceString = 'Mobile (Android)';
      else deviceString = 'Dispositivo Móvel';
    } else if (isWindows) {
      deviceType = 'windows';
      deviceString = 'Windows (PC)';
    } else if (isMac) {
      deviceType = 'other';
      deviceString = 'macOS (Desktop)';
    } else if (isLinux) {
      deviceType = 'other';
      deviceString = 'Linux (Workstation)';
    }
    return { deviceString, deviceType };
  }

  function saveDbState() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const dataToPersist = {
        version: 3,
        lastSaved: new Date().toISOString(),
        tracks,
        vehicles,
        movements,
        schedules,
        notifications,
        rules,
        auditLogs,
        activeManobrador,
        users,
      };
      const tmp = `${DB_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(dataToPersist, null, 2), 'utf-8');
      fs.renameSync(tmp, DB_FILE);
      // Also ensure isolated users database is always in sync
      saveUsersToDisk();
    } catch (e) {
      console.error('[Storage Error] Falha ao persistir estado do pátio no disco:', e);
    }
  }

  function loadDbState(): boolean {
    try {
      const usersLoaded = loadUsersFromDisk();

      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.tracks) && data.tracks.length > 0) tracks = data.tracks;
        if (Array.isArray(data.vehicles) && data.vehicles.length > 0) {
          vehicles = data.vehicles.map(v => {
            if (v.operatorCompany && v.operatorCompany.includes('Metrô CCO')) {
              return { ...v, operatorCompany: 'VLT Carioca' };
            }
            return v;
          });
        }
        if (Array.isArray(data.movements)) movements = data.movements;
        if (Array.isArray(data.schedules)) schedules = data.schedules;
        if (Array.isArray(data.notifications)) notifications = data.notifications;
        if (Array.isArray(data.rules)) rules = data.rules;
        if (Array.isArray(data.auditLogs)) auditLogs = data.auditLogs;
        if (data.activeManobrador !== undefined) activeManobrador = data.activeManobrador;

        if (!usersLoaded) {
          if (Array.isArray(data.users) && data.users.length > 0) {
            users = data.users;
            saveUsersToDisk();
          } else {
            users = JSON.parse(JSON.stringify(INITIAL_USERS));
            saveUsersToDisk();
          }
        } else if (Array.isArray(data.users) && data.users.length > 0) {
          let needResave = false;
          for (const u of data.users) {
            if (!users.some(existing => existing.id === u.id || matchUserBadge(u.badgeNumber, existing.badgeNumber))) {
              users.push(u);
              needResave = true;
            }
          }
          if (needResave) saveUsersToDisk();
        }

        console.log(`[Storage] Memória contínua carregada com sucesso (${movements.length} movimentações, ${vehicles.length} veículos, ${users.length} operadores).`);
        return true;
      } else {
        if (!usersLoaded) {
          users = JSON.parse(JSON.stringify(INITIAL_USERS));
          saveUsersToDisk();
        }
      }
    } catch (e) {
      console.error('[Storage Error] Falha ao carregar memória contínua do disco:', e);
    }
    return false;
  }

  // Load continuous memory on server start
  const loadedFromDisk = loadDbState();
  if (!loadedFromDisk) {
    saveDbState();
  }

  // Server-Sent Events (SSE) connected clients for real-time dispatch
  type SSEClient = { id: string; res: express.Response };
  const sseClients: SSEClient[] = [];

  function broadcastEvent(eventType: string, data: any) {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (let i = sseClients.length - 1; i >= 0; i--) {
      try {
        sseClients[i].res.write(payload);
      } catch (e) {
        sseClients.splice(i, 1);
      }
    }
  }

  function recalculateTrackStatus(track: YardTrack): YardTrack {
    const assigned = track.assignedVehicles.length;
    const ratio = track.capacityWagons > 0 ? assigned / track.capacityWagons : 0;

    if (track.status === 'interdicted') return track;

    if (ratio === 0) {
      track.status = 'available';
    } else if (ratio < 0.4) {
      track.status = 'available';
    } else if (ratio < 0.75) {
      track.status = 'moderate';
    } else if (ratio < 0.9) {
      track.status = 'high';
    } else {
      track.status = 'critical';
    }
    return track;
  }

  // API ROUTES FIRST

  // 1. Health & Status
  app.get('/api/v1/health', (req, res) => {
    res.json({
      status: 'online',
      system: 'FerroPátio CCO Engine',
      version: '2.4.0',
      timestamp: new Date().toISOString(),
      activeClientsSSE: sseClients.length,
      tracksCount: tracks.length,
      vehiclesCount: vehicles.length,
    });
  });

  // 2. Yard Layout & Real-Time Status
  app.get('/api/v1/yard', (req, res) => {
    // Calculate global stats based on actual composition capacity / spots
    const totalWagonCapacity = tracks.reduce((acc, t) => acc + ((t.spots && t.spots.length > 0) ? t.spots.length : (t.capacityWagons || 1)), 0);
    const occupiedWagons = tracks.reduce((acc, t) => {
      if (t.spots && t.spots.length > 0) {
        return acc + t.spots.filter(s => s.status === 'occupied' || !!s.vehicleId).length;
      }
      return acc + (t.assignedVehicles?.length || 0);
    }, 0);
    const overallOccupancyPct = totalWagonCapacity > 0 ? Math.round((occupiedWagons / totalWagonCapacity) * 100) : 0;
    const activeVehicles = vehicles.filter(v => v.currentTrackId !== null);
    const inMaintenanceCount = vehicles.filter(v => v.status === 'in_maintenance' || v.maintenanceStatus === 'in_progress').length;
    const criticalTracks = tracks.filter(t => t.status === 'critical' || t.status === 'high');

    res.json({
      tracks,
      vehicles,
      summary: {
        totalTracks: tracks.length,
        availableTracks: tracks.filter(t => t.status === 'available').length,
        criticalTracksCount: criticalTracks.length,
        interdictedTracksCount: tracks.filter(t => t.status === 'interdicted').length,
        totalWagonCapacity,
        occupiedWagons,
        overallOccupancyPct,
        activeVehiclesInYard: activeVehicles.length,
        inMaintenanceCount,
        recentMovementsCount: movements.length,
      }
    });
  });

  // Helper function to detect maintenance shunting reasons:
  // Higienização, Revisão de ar, Manutenção preventiva, Manutenção corretiva, Inspeção de truque
  function isMaintenanceReason(reason?: string | null): boolean {
    if (!reason) return false;
    const norm = reason
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();

    return (
      norm.includes('higienizacao') ||
      norm.includes('revisao de ar') ||
      norm.includes('manutencao preventiva') ||
      norm.includes('manutencao corretiva') ||
      norm.includes('inspecao de truque') ||
      norm.includes('truque')
    );
  }

  // 3. Register New Movement
  app.post('/api/v1/movements', (req, res) => {
    const {
      vehicleId,
      type,
      reason,
      sourceTrackId,
      targetTrackId,
      operatorId,
      operatorName,
      operatorRole,
      authorizedByCCO,
      safetyChecklist,
      notes,
      newVehicleData,
    } = req.body;

    if (!vehicleId || !type || !reason) {
      return res.status(400).json({ error: 'Campos obrigatórios ausentes: vehicleId, type, reason' });
    }

    // TRAVA OPERACIONAL DE MANOBRADOR:
    if (activeManobrador) {
      if (operatorId && activeManobrador.userId !== operatorId) {
        return res.status(403).json({
          error: `TRAVA DE MANOBRADOR: O pátio está sob comando exclusivo do Manobrador ativo ${activeManobrador.userName} (${activeManobrador.badgeNumber}). Nenhum outro operador pode realizar manobras enquanto esta função estiver ocupada.`
        });
      }
    }

    let vehicle = vehicles.find(v => v.id === vehicleId);
    if (!vehicle && newVehicleData) {
      vehicle = {
        id: newVehicleData.id || vehicleId,
        name: newVehicleData.name || `TUE ${vehicleId}`,
        type: newVehicleData.type || 'train_passenger',
        model: newVehicleData.model || 'Alstom Metropolis Série 8500',
        operatorCompany: newVehicleData.operatorCompany || 'VLT Carioca',
        lengthMeters: newVehicleData.lengthMeters || 170,
        weightTons: newVehicleData.weightTons || 310,
        status: 'stabled',
        currentTrackId: null,
        entryDate: new Date().toISOString(),
        entryReason: reason,
        registeredBy: operatorName || 'Operador de Pátio',
        maintenanceStatus: 'up_to_date',
        preventiveMaintenanceDueDate: new Date(Date.now() + 86400000 * 30).toISOString(),
        destination: 'Linha Comercial',
        estimatedDwellTimeHours: newVehicleData.estimatedDwellTimeHours || 4.0,
        departureEta: newVehicleData.departureEta || new Date(Date.now() + 14400000).toISOString(),
        lastMovedAt: new Date().toISOString(),
        passengerService: newVehicleData.passengerService || 'Linha 11 - Coral (Comercial)',
        passengerCapacity: newVehicleData.passengerCapacity || 2040,
        carCount: newVehicleData.carCount || 8,
        cargoType: newVehicleData.cargoType || 'Transporte de Passageiros (8 Carros Climatizados)',
      };
      vehicles.push(vehicle);
    }

    if (!vehicle) {
      return res.status(404).json({ error: `Veículo ${vehicleId} não encontrado no sistema.` });
    }

    const nowIso = new Date().toISOString();
    const sourceTrack = sourceTrackId ? tracks.find(t => t.id === sourceTrackId) : null;
    const targetTrack = targetTrackId ? tracks.find(t => t.id === targetTrackId) : null;

    // Check capacity if moving into a track
    if (targetTrack && type !== 'exit') {
      if (targetTrack.status === 'interdicted') {
        return res.status(400).json({ 
          error: `A via de destino ${targetTrack.name} está INTERDITADA para manutenção de via.` 
        });
      }

      // REGRA DE IMPEDIMENTO DE MANOBRAS CASO A VIA DE DESTINO ESTEJA OCUPADA
      const isAlreadyOnTargetTrack = vehicle && (vehicle.currentTrackId === targetTrack.id || sourceTrackId === targetTrack.id);
      const hasFreeSpot = isAlreadyOnTargetTrack
        ? true
        : targetTrack.spots && targetTrack.spots.length > 0
          ? targetTrack.spots.some(s => s.status === 'free')
          : (targetTrack.assignedVehicles.length < (targetTrack.capacityWagons || 1) && targetTrack.status !== 'critical');

      if (!hasFreeSpot) {
        return res.status(400).json({
          error: `BLOQUEIO DE INTERTRAVAMENTO: Manobra impedida! A via de destino ${targetTrack.code} (${targetTrack.name}) encontra-se totalmente ocupada.`
        });
      }
    }

    // Remove vehicle from old track and free its spot
    if (sourceTrack) {
      sourceTrack.assignedVehicles = sourceTrack.assignedVehicles.filter(id => id !== vehicleId);
      if (sourceTrack.spots) {
        for (const sp of sourceTrack.spots) {
          if (sp.vehicleId === vehicleId) {
            sp.status = 'free';
            sp.vehicleId = null;
          }
        }
      }
      recalculateTrackStatus(sourceTrack);
    } else if (vehicle.currentTrackId) {
      const prevTrack = tracks.find(t => t.id === vehicle.currentTrackId);
      if (prevTrack) {
        prevTrack.assignedVehicles = prevTrack.assignedVehicles.filter(id => id !== vehicleId);
        if (prevTrack.spots) {
          for (const sp of prevTrack.spots) {
            if (sp.vehicleId === vehicleId) {
              sp.status = 'free';
              sp.vehicleId = null;
            }
          }
        }
        recalculateTrackStatus(prevTrack);
      }
    }

    // Clear previous spot reference across all tracks to ensure consistency
    for (const t of tracks) {
      if (t.spots) {
        for (const sp of t.spots) {
          if (sp.vehicleId === vehicleId) {
            sp.status = 'free';
            sp.vehicleId = null;
          }
        }
      }
    }

    let assignedSpot: any = null;
    let ruleViolationWarning: string | null = null;

    // Add vehicle to new track (unless exit)
    if (type === 'exit') {
      vehicle.currentTrackId = null;
      vehicle.currentSpotId = null;
      vehicle.status = 'ready_for_dispatch';
    } else if (targetTrack) {
      if (!targetTrack.assignedVehicles.includes(vehicleId)) {
        targetTrack.assignedVehicles.push(vehicleId);
      }
      vehicle.currentTrackId = targetTrack.id;

      // Handle parking spot allocation with End-of-Track priority rule (E1-E6, LP)
      const targetSpots = targetTrack.spots || [];
      if (targetSpots.length > 0) {
        const isPriorityRuleTrack = targetTrack.parkingRule?.type === 'end_of_track_first' || 
          ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'LP'].includes(targetTrack.code);

        if (isPriorityRuleTrack) {
          // Sort free spots by priority: 1 (Posição A / Fim de Via) -> 2 (Posição B) -> 3 (Posição C)
          const freeSpots = targetSpots.filter(s => s.status === 'free').sort((a, b) => (a.priority || 99) - (b.priority || 99));

          if (req.body.targetSpotId) {
            const requestedSpot = targetSpots.find(s => s.id === req.body.targetSpotId);
            if (requestedSpot) {
              // Check if a higher priority spot (closer to end of track) was free
              const higherPriorityFreeSpot = freeSpots.find(s => (s.priority || 99) < (requestedSpot.priority || 99));
              if (higherPriorityFreeSpot) {
                ruleViolationWarning = `Regra de Estacionamento: ${requestedSpot.positionName || requestedSpot.id} alocada enquanto ${higherPriorityFreeSpot.positionName || higherPriorityFreeSpot.id} no fim de via estava disponível.`;
              }
              assignedSpot = requestedSpot;
            }
          }

          // If no specific spot requested, automatically assign highest priority free spot (Pos A -> Pos B -> Pos C)
          if (!assignedSpot && freeSpots.length > 0) {
            assignedSpot = freeSpots[0];
          }
        } else {
          if (req.body.targetSpotId) {
            assignedSpot = targetSpots.find(s => s.id === req.body.targetSpotId);
          }
          if (!assignedSpot) {
            assignedSpot = targetSpots.find(s => s.status === 'free');
          }
        }

        if (assignedSpot) {
          assignedSpot.status = 'occupied';
          assignedSpot.vehicleId = vehicleId;
          vehicle.currentSpotId = assignedSpot.id;
        }
      }

      recalculateTrackStatus(targetTrack);

      const isMaintReason = isMaintenanceReason(reason);
      if (isMaintReason || targetTrack.category === 'maintenance' || targetTrack.category === 'workshop') {
        vehicle.status = 'in_maintenance';
        vehicle.maintenanceStatus = 'in_progress';
      } else if (type === 'entry') {
        vehicle.status = 'stabled';
      }
    } else {
      // Maneuver without specific targetTrack change
      if (isMaintenanceReason(reason)) {
        vehicle.status = 'in_maintenance';
        vehicle.maintenanceStatus = 'in_progress';
      }
    }

    // Regra Operacional: Se o motivo for higienização, revisão de ar, manutenção preventiva, corretiva ou inspeção de truque,
    // o status da composição DEVE alterar diretamente para "em manutenção".
    if (isMaintenanceReason(reason)) {
      vehicle.status = 'in_maintenance';
      vehicle.maintenanceStatus = 'in_progress';
    }

    vehicle.lastMovedAt = nowIso;
    if (type === 'entry') {
      vehicle.entryDate = nowIso;
      vehicle.entryReason = reason;
      vehicle.registeredBy = operatorName || 'Operador de Pátio';
    }

    const designatedLine = req.body.designatedLine || (type === 'exit' ? (vehicle.designatedLine || vehicle.passengerService || 'Linha 1 - Azul') : undefined);
    const designatedDestination = req.body.designatedDestination || (type === 'exit' ? (vehicle.designatedDestination || vehicle.destination || 'Terminal Gentileza') : undefined);

    if (designatedLine) {
      vehicle.designatedLine = designatedLine;
      vehicle.passengerService = designatedLine;
    }
    if (designatedDestination) {
      vehicle.designatedDestination = designatedDestination;
      vehicle.destination = designatedDestination;
    }

    // Create Movement Record
    const newMovement: MovementRecord = {
      id: `MOV-${Date.now().toString().slice(-8)}`,
      timestamp: nowIso,
      vehicleId: vehicle.id,
      vehicleName: vehicle.name,
      vehicleType: vehicle.type,
      type,
      reason,
      sourceTrackId: sourceTrack ? sourceTrack.id : null,
      targetTrackId: targetTrack ? targetTrack.id : null,
      targetSpotId: assignedSpot ? assignedSpot.id : (req.body.targetSpotId || null),
      designatedLine: designatedLine || undefined,
      designatedDestination: designatedDestination || undefined,
      sourceTrackName: sourceTrack ? sourceTrack.name : (req.body.sourceTrackName || (type === 'entry' ? 'Via Comercial' : 'Linha Externa Tronco')),
      targetTrackName: targetTrack ? targetTrack.name : (type === 'exit' ? (designatedDestination ? `Despacho: ${designatedDestination}` : 'Despacho Linha Tronco') : 'Pátio'),
      operatorId: operatorId || 'USR-02',
      operatorName: operatorName || 'Operador de Pátio',
      operatorRole: operatorRole || 'Manobrador',
      authorizedByCCO: authorizedByCCO || 'Central CCO',
      safetyChecklist: safetyChecklist || {
        handbrakeApplied: true,
        trackChocksInstalled: true,
        signalingFlagsPlaced: true,
        visualInspectionDone: true,
      },
      notes: notes ? `${notes}${ruleViolationWarning ? ` | ${ruleViolationWarning}` : ''}` : (ruleViolationWarning || ''),
    };

    movements.unshift(newMovement);

    // Create Audit Log
    const auditEntry: AuditLogEntry = {
      id: `AUDIT-${Date.now().toString().slice(-6)}`,
      timestamp: nowIso,
      userId: operatorId || 'USR-02',
      userName: operatorName || 'Operador de Pátio',
      userRole: operatorRole || 'Operador',
      action: `MOVIMENTO_${type.toUpperCase()}`,
      entityType: 'movement',
      entityId: newMovement.id,
      details: `${vehicle.id} (${vehicle.name}) movido de [${newMovement.sourceTrackName}] para [${newMovement.targetTrackName}] por motivo: ${reason}`,
      clientIp: req.ip || '127.0.0.1',
      device: req.headers['user-agent'] || 'Console',
    };
    auditLogs.unshift(auditEntry);

    // Automated CCO Notification Generation & Custom Rule Evaluation
    let newAlert: NotificationAlert | null = null;
    
    // Check if any custom rule matches this event
    for (const rule of rules) {
      if (!rule.isActive) continue;

      let ruleMatched = false;
      let ruleAlertTitle = '';
      let ruleAlertMessage = '';

      if (rule.eventType === 'cargo_arrival' && (type === 'entry' || type === 'shunting')) {
        const filter = (rule.criteria?.cargoFilter || '').toLowerCase().trim();
        const trainDesc = `${vehicle.passengerService || ''} ${vehicle.cargoType || ''} ${vehicle.name || ''} ${reason}`.toLowerCase();
        if (filter && trainDesc.includes(filter)) {
          ruleMatched = true;
          ruleAlertTitle = `[REGRA DISPARADA] ${rule.name}`;
          ruleAlertMessage = `Detecção de movimentação: ${vehicle.id} (${vehicle.name}) na ${targetTrack?.name || 'via'}. Critério atendido: "${rule.criteria?.cargoFilter}".`;
        }
      } else if (rule.eventType === 'zone_occupancy' && targetTrack) {
        const threshold = rule.criteria?.thresholdPercent || 80;
        const currentPct = targetTrack.capacityWagons > 0 ? (targetTrack.assignedVehicles.length / targetTrack.capacityWagons) * 100 : 0;
        if (currentPct >= threshold) {
          ruleMatched = true;
          ruleAlertTitle = `[REGRA DISPARADA] ${rule.name}`;
          ruleAlertMessage = `A via ${targetTrack.name} atingiu ${Math.round(currentPct)}% de ocupação (Limite da regra: ${threshold}%).`;
        }
      }

      if (ruleMatched) {
        rule.triggerCount += 1;
        rule.lastTriggeredAt = nowIso;
        newAlert = {
          id: `NOTIF-${Date.now().toString().slice(-6)}`,
          timestamp: nowIso,
          title: ruleAlertTitle,
          message: ruleAlertMessage,
          severity: 'warning',
          category: rule.eventType === 'cargo_arrival' ? 'cargo' : 'occupancy',
          read: false,
          relatedVehicleId: vehicle.id,
          relatedTrackId: targetTrack?.id,
          channelsDispatched: {
            push: rule.channels.pushApp,
            email: rule.channels.email,
            sms: rule.channels.sms,
          },
          recipientsSummary: [
            rule.channels.pushApp ? 'App Push' : null,
            rule.channels.email ? `Email (${rule.recipients.emails || 'cco@ferropatio.com.br'})` : null,
            rule.channels.sms ? `SMS (${rule.recipients.phones || '+55 11 98888-7711'})` : null,
          ].filter(Boolean).join(' + '),
          confirmed: false,
          ruleId: rule.id,
        };
        notifications.unshift(newAlert);
        broadcastEvent('new_notification', { alert: newAlert });
        broadcastEvent('rules_updated', { rules });
        break;
      }
    }

    if (!newAlert) {
      if (targetTrack && (targetTrack.status === 'critical' || targetTrack.status === 'high')) {
        newAlert = {
          id: `NOTIF-${Date.now().toString().slice(-6)}`,
          timestamp: nowIso,
          title: `Alerta CCO: Ocupação Elevada na ${targetTrack.code}`,
          message: `A via ${targetTrack.name} está agora com ${targetTrack.assignedVehicles.length} composições (Capacidade máx: ${targetTrack.capacityWagons}).`,
          severity: targetTrack.status === 'critical' ? 'critical' : 'warning',
          category: 'occupancy',
          read: false,
          relatedTrackId: targetTrack.id,
          channelsDispatched: { push: true, email: true, sms: false },
          confirmed: false,
        };
        notifications.unshift(newAlert);
      } else if (isMaintenanceReason(reason)) {
        newAlert = {
          id: `NOTIF-${Date.now().toString().slice(-6)}`,
          timestamp: nowIso,
          title: `Status: EM MANUTENÇÃO (${vehicle.id})`,
          message: `${vehicle.name} (${vehicle.id}) transferido para status EM MANUTENÇÃO por motivo operacional: "${reason}".`,
          severity: 'warning',
          category: 'maintenance',
          read: false,
          relatedVehicleId: vehicle.id,
          relatedTrackId: targetTrack?.id,
          channelsDispatched: { push: true, email: false, sms: false },
          confirmed: false,
        };
        notifications.unshift(newAlert);
      } else if (type === 'entry') {
        newAlert = {
          id: `NOTIF-${Date.now().toString().slice(-6)}`,
          timestamp: nowIso,
          title: `Entrada Registrada: ${vehicle.id}`,
          message: `${vehicle.name} deu entrada na ${targetTrack?.name || 'via'}. Motivo: ${reason}. Operador: ${operatorName}.`,
          severity: 'info',
          category: 'movement',
          read: false,
          relatedVehicleId: vehicle.id,
          relatedTrackId: targetTrack?.id,
          channelsDispatched: { push: true, email: false, sms: false },
          confirmed: false,
        };
        notifications.unshift(newAlert);
      } else if (type === 'exit') {
        newAlert = {
          id: `NOTIF-${Date.now().toString().slice(-6)}`,
          timestamp: nowIso,
          title: `Despacho / Saída Concluída: ${vehicle.id}`,
          message: `${vehicle.name} liberado do pátio para circulação na linha comercial. Autorizado por: ${authorizedByCCO}.`,
          severity: 'success',
          category: 'movement',
          read: false,
          relatedVehicleId: vehicle.id,
          channelsDispatched: { push: true, email: false, sms: false },
          confirmed: false,
        };
        notifications.unshift(newAlert);
      }
    }

    // Calculate live updated occupancy percentage
    const liveCapacity = tracks.reduce((acc, t) => acc + ((t.spots && t.spots.length > 0) ? t.spots.length : (t.capacityWagons || 1)), 0);
    const liveOccupied = tracks.reduce((acc, t) => {
      if (t.spots && t.spots.length > 0) {
        return acc + t.spots.filter(s => s.status === 'occupied' || !!s.vehicleId).length;
      }
      return acc + (t.assignedVehicles?.length || 0);
    }, 0);
    const liveOccupancyPct = liveCapacity > 0 ? Math.round((liveOccupied / liveCapacity) * 100) : 0;

    // Broadcast Real-Time update to all connected sessions
    broadcastEvent('movement_registered', {
      movement: newMovement,
      vehicle,
      tracks,
      alert: newAlert,
      overallOccupancyPct: liveOccupancyPct,
    });

    saveDbState();

    res.status(201).json({
      success: true,
      movement: newMovement,
      vehicle,
      tracks,
      alert: newAlert,
      overallOccupancyPct: liveOccupancyPct,
    });
  });

  // 4. Get Movements List
  app.get('/api/v1/movements', (req, res) => {
    const { vehicleId, type, limit } = req.query;
    let filtered = [...movements];

    if (vehicleId) {
      filtered = filtered.filter(m => m.vehicleId === vehicleId);
    }
    if (type) {
      filtered = filtered.filter(m => m.type === type);
    }
    if (limit) {
      filtered = filtered.slice(0, parseInt(limit as string, 10));
    }

    res.json({
      total: filtered.length,
      movements: filtered,
    });
  });

  // 4b. Update Movement (e.g. edit ODT name)
  app.patch('/api/v1/movements/:id', (req, res) => {
    const { id } = req.params;
    const { authorizedByCCO } = req.body;
    const movement = movements.find(m => m.id === id);
    if (!movement) {
      return res.status(404).json({ error: 'Movimentação não encontrada' });
    }
    if (authorizedByCCO !== undefined) {
      movement.authorizedByCCO = String(authorizedByCCO).trim();
    }
    saveDbState();
    broadcastEvent('movement_updated', { movement });
    console.log(`[Movements] Movimentação ${id} atualizada com ODT: "${movement.authorizedByCCO}"`);
    res.json({ success: true, movement });
  });

  // 5. Complete Vehicle Passport & Full Life-Cycle History
  app.get('/api/v1/vehicles/:id/passport', (req, res) => {
    const { id } = req.params;
    const vehicle = vehicles.find(v => v.id.toLowerCase() === id.toLowerCase());
    if (!vehicle) {
      return res.status(404).json({ error: `Veículo ferroviário com código ${id} não localizado.` });
    }

    const vehicleMovements = movements.filter(m => m.vehicleId === vehicle.id);
    const vehicleSchedules = schedules.filter(s => s.vehicleId === vehicle.id);
    const currentTrack = vehicle.currentTrackId ? tracks.find(t => t.id === vehicle.currentTrackId) : null;

    res.json({
      vehicle,
      currentTrack,
      movementsCount: vehicleMovements.length,
      history: vehicleMovements,
      schedules: vehicleSchedules,
      dwellTimeHours: vehicle.dwellTimeHours || 12.5,
    });
  });

  // 5.1. Vehicle Composition Status (Operacional vs Em Manutenção with RBAC)
  app.post('/api/v1/vehicles/:id/status', (req, res) => {
    const { id } = req.params;
    const { targetStatus, user, reason } = req.body;
    const vehicle = vehicles.find(v => v.id.toLowerCase() === id.toLowerCase());
    if (!vehicle) {
      return res.status(404).json({ error: `Veículo ${id} não localizado.` });
    }

    if (!user || !user.role) {
      return res.status(400).json({ error: 'Operador não identificado para autorização.' });
    }

    const role = user.role;

    // Regra: Se a composição estiver com status em manutenção, somente o Técnico MRO pode alterar
    const currentIsMaintenance = vehicle.status === 'in_maintenance' || vehicle.maintenanceStatus === 'in_progress';
    if (currentIsMaintenance) {
      if (role !== 'tecnico_mro' && role !== 'maintenance_tech') {
        return res.status(403).json({
          error: 'PERMISSÃO NEGADA: A composição está EM MANUTENÇÃO. Somente o Técnico MRO possui autorização para alterar o status deste trem.'
        });
      }
    }

    const isOperacional = targetStatus === 'operacional' || targetStatus === 'active' || targetStatus === 'stabled';
    const isManutencao = targetStatus === 'em_manutencao' || targetStatus === 'in_maintenance';
    const isPreparadoComercial = targetStatus === 'preparado_comercial' || targetStatus === 'ready_for_dispatch' || targetStatus === 'ready_commercial';

    let resolvedStatusLabel = 'OPERACIONAL';

    if (isOperacional) {
      if (role !== 'tecnico_mro' && role !== 'supervisor_cco' && role !== 'maintenance_tech' && role !== 'admin') {
        return res.status(403).json({
          error: 'PERMISSÃO NEGADA: Apenas o Técnico MRO ou Supervisor de CCO possuem autorização para alterar o status de composição para OPERACIONAL.'
        });
      }
      vehicle.status = 'active';
      vehicle.maintenanceStatus = 'up_to_date';
      resolvedStatusLabel = 'OPERACIONAL';
    } else if (isManutencao) {
      if (role !== 'controlador_cco' && role !== 'supervisor_cco' && role !== 'cco_dispatcher' && role !== 'admin') {
        return res.status(403).json({
          error: 'PERMISSÃO NEGADA: Apenas o Controlador CCO ou Supervisor de CCO possuem autorização para alterar o status de composição para EM MANUTENÇÃO.'
        });
      }
      vehicle.status = 'in_maintenance';
      vehicle.maintenanceStatus = 'in_progress';
      resolvedStatusLabel = 'EM MANUTENÇÃO';
    } else if (isPreparadoComercial) {
      if (role !== 'controlador_cco' && role !== 'supervisor_cco' && role !== 'cco_dispatcher' && role !== 'admin') {
        return res.status(403).json({
          error: 'PERMISSÃO NEGADA: Apenas o Controlador CCO ou Supervisor de CCO possuem autorização para alterar o status de composição para PREPARADO PARA O COMERCIAL.'
        });
      }
      vehicle.status = 'ready_for_dispatch';
      vehicle.maintenanceStatus = 'up_to_date';
      resolvedStatusLabel = 'PREPARADO PARA O COMERCIAL';
    } else {
      return res.status(400).json({ error: 'Status pretendido inválido.' });
    }

    vehicle.lastMovedAt = new Date().toISOString();

    const auditEntry: AuditLogEntry = {
      id: `AUDIT-${Date.now().toString().slice(-6)}`,
      timestamp: new Date().toISOString(),
      userId: user.id,
      userName: user.name,
      userRole: user.roleLabel || user.role,
      action: `STATUS_VEICULO_${isOperacional ? 'OPERACIONAL' : isPreparadoComercial ? 'PREPARADO_COMERCIAL' : 'MANUTENCAO'}`,
      entityType: 'vehicle',
      entityId: vehicle.id,
      details: `Status da composição ${vehicle.id} alterado para [${resolvedStatusLabel}]. Motivo: ${reason || 'Ação operacional de pátio'}.`,
      clientIp: req.ip || '127.0.0.1',
      device: req.headers['user-agent'] || 'Console',
    };
    auditLogs.unshift(auditEntry);

    broadcastEvent('vehicle_status_updated', { vehicle });
    broadcastEvent('spot_updated', { tracks });
    saveDbState();

    res.json({
      success: true,
      vehicle,
      statusLabel: resolvedStatusLabel,
    });
  });

  // 5.1.1. Designar Linha e Destino para Despacho da Composição (VLT Carioca)
  app.post('/api/v1/vehicles/:id/dispatch-assignment', (req, res) => {
    const { id } = req.params;
    const { designatedLine, designatedDestination, user, notes } = req.body;
    const vehicle = vehicles.find(v => v.id.toLowerCase() === id.toLowerCase());
    if (!vehicle) {
      return res.status(404).json({ error: `Veículo ${id} não localizado.` });
    }

    if (!designatedLine || !designatedDestination) {
      return res.status(400).json({ error: 'Linha e Destino são obrigatórios para a programação de despacho.' });
    }

    vehicle.designatedLine = designatedLine;
    vehicle.passengerService = designatedLine;
    vehicle.designatedDestination = designatedDestination;
    vehicle.destination = designatedDestination;
    if (notes) {
      vehicle.notes = notes;
    }

    const auditEntry: AuditLogEntry = {
      id: `AUDIT-${Date.now().toString().slice(-6)}`,
      timestamp: new Date().toISOString(),
      userId: user?.id || 'USR-01',
      userName: user?.name || 'Operador CCO',
      userRole: user?.roleLabel || user?.role || 'CCO',
      action: 'DESPACHO_PROGRAMACAO_LINHA_DESTINO',
      entityType: 'vehicle',
      entityId: vehicle.id,
      details: `Composição ${vehicle.id} programada para despacho na Linha: "${designatedLine}" com Destino: "${designatedDestination}".`,
      clientIp: req.ip || '127.0.0.1',
      device: req.headers['user-agent'] || 'Console',
    };
    auditLogs.unshift(auditEntry);

    broadcastEvent('vehicle_updated', { vehicle });
    saveDbState();

    res.json({
      success: true,
      vehicle,
      message: `Composição ${vehicle.id} designada com sucesso para ${designatedLine} com destino a ${designatedDestination}.`,
    });
  });

  // 5.1.2. Alternar / Definir Celular Operacional da Composição ("Cel")
  app.post('/api/v1/vehicles/:id/operational-phone', (req, res) => {
    const { id } = req.params;
    const { hasOperationalPhone, operationalPhoneNotes, user } = req.body;
    const vehicle = vehicles.find(v => v.id.toLowerCase() === id.toLowerCase());
    if (!vehicle) {
      return res.status(404).json({ error: `Veículo ${id} não localizado.` });
    }

    const nextState = typeof hasOperationalPhone === 'boolean' 
      ? hasOperationalPhone 
      : !vehicle.hasOperationalPhone;

    vehicle.hasOperationalPhone = nextState;
    if (operationalPhoneNotes !== undefined) {
      vehicle.operationalPhoneNotes = operationalPhoneNotes;
    }

    const auditEntry: AuditLogEntry = {
      id: `AUDIT-${Date.now().toString().slice(-6)}`,
      timestamp: new Date().toISOString(),
      userId: user?.id || 'USR-01',
      userName: user?.name || 'Operador CCO',
      userRole: user?.roleLabel || user?.role || 'CCO',
      action: 'CELULAR_OPERACIONAL_ATUALIZADO',
      entityType: 'vehicle',
      entityId: vehicle.id,
      details: `Composição ${vehicle.id}: Celular operacional ${nextState ? 'VINCULADO (Indicador Cel ativo no pátio)' : 'DESVINCULADO'}. ${operationalPhoneNotes ? `Obs: ${operationalPhoneNotes}` : ''}`,
      clientIp: req.ip || '127.0.0.1',
      device: req.headers['user-agent'] || 'Console',
    };
    auditLogs.unshift(auditEntry);

    broadcastEvent('vehicle_updated', { vehicle });
    broadcastEvent('vehicle_status_updated', { vehicle });
    saveDbState();

    res.json({
      success: true,
      vehicle,
      hasOperationalPhone: nextState,
      message: `Composição ${vehicle.id}: Celular operacional ${nextState ? 'marcado como presente (Cel)' : 'desmarcado'}.`,
    });
  });

  // 5.2. Manobrador Exclusivity Endpoints
  app.get('/api/v1/manobrador', (req, res) => {
    res.json({ activeManobrador });
  });

  app.post('/api/v1/manobrador/activate', (req, res) => {
    const { user } = req.body;
    if (!user || !user.id || !user.name) {
      return res.status(400).json({ error: 'Identificação de operador obrigatória.' });
    }

    const isCallerSupervisor = user.role === 'supervisor_cco' || user.role === 'admin';
    if (activeManobrador && activeManobrador.userId !== user.id && !isCallerSupervisor) {
      return res.status(409).json({
        error: `O operador ${activeManobrador.userName} (Matrícula ${activeManobrador.badgeNumber}) já está com a função de Manobrador ativa. Apenas um operador pode manobrar no pátio por vez.`
      });
    }

    const wasOverride = activeManobrador && activeManobrador.userId !== user.id;

    activeManobrador = {
      userId: user.id,
      userName: user.name,
      badgeNumber: user.badgeNumber || '38-00000',
      role: user.role,
      roleLabel: user.roleLabel || 'Manobrador',
      activatedAt: new Date().toISOString(),
    };

    const auditEntry: AuditLogEntry = {
      id: `AUDIT-${Date.now().toString().slice(-6)}`,
      timestamp: new Date().toISOString(),
      userId: user.id,
      userName: user.name,
      userRole: user.roleLabel || user.role,
      action: wasOverride ? 'MANOBRADOR_ASSUMIDO_OVERRIDE' : 'MANOBRADOR_ASSUMIDO',
      entityType: 'auth',
      entityId: user.id,
      details: wasOverride 
        ? `Supervisão CCO realizou override e assumiu a função exclusiva de Manobrador do pátio.`
        : `Operador assumiu a função de Manobrador do pátio. Manobras trancadas para demais usuários.`,
      clientIp: req.ip || '127.0.0.1',
      device: req.headers['user-agent'] || 'Console',
    };
    auditLogs.unshift(auditEntry);

    broadcastEvent('manobrador_changed', { activeManobrador });
    saveDbState();
    res.json({ success: true, activeManobrador });
  });

  app.post('/api/v1/manobrador/release', (req, res) => {
    const { userId, userRole, force } = req.body;
    if (!activeManobrador) {
      return res.json({ success: true, activeManobrador: null });
    }

    const isSupervisorUser = userRole === 'supervisor_cco' || userRole === 'admin' || force;
    if (activeManobrador.userId !== userId && !isSupervisorUser) {
      return res.status(403).json({
        error: 'Apenas o Manobrador ativo ou um Supervisor de CCO pode liberar a função.'
      });
    }

    const prevManobrador = activeManobrador;
    activeManobrador = null;

    const auditEntry: AuditLogEntry = {
      id: `AUDIT-${Date.now().toString().slice(-6)}`,
      timestamp: new Date().toISOString(),
      userId: userId || prevManobrador.userId,
      userName: prevManobrador.userName,
      userRole: userRole || prevManobrador.roleLabel,
      action: 'MANOBRADOR_LIBERADO',
      entityType: 'auth',
      entityId: prevManobrador.userId,
      details: `Função de Manobrador liberada pelo operador. Pátio liberado para nova assunção.`,
      clientIp: req.ip || '127.0.0.1',
      device: req.headers['user-agent'] || 'Console',
    };
    auditLogs.unshift(auditEntry);

    broadcastEvent('manobrador_changed', { activeManobrador: null });
    saveDbState();
    res.json({ success: true, activeManobrador: null });
  });

  // 6. Preventive Maintenance Schedules API (Integration with SAP PM / Maximo)
  app.get('/api/v1/schedules', (req, res) => {
    res.json({
      total: schedules.length,
      schedules,
    });
  });

  // Add maintenance schedule
  app.post('/api/v1/schedules', (req, res) => {
    const {
      vehicleId,
      vehicleName,
      type,
      scheduledDate,
      estimatedDurationHours,
      assignedWorkshopTrackId,
      systemSource,
      technicianInCharge,
      description,
      externalSystemId,
    } = req.body;

    const newSchedule: MaintenanceSchedule = {
      id: `SCH-${Date.now().toString().slice(-6)}`,
      vehicleId: vehicleId || 'LOC-9042',
      vehicleName: vehicleName || 'Locomotiva',
      type: type || 'Preventiva Sistemática',
      scheduledDate: scheduledDate || new Date().toISOString(),
      estimatedDurationHours: Number(estimatedDurationHours) || 6,
      assignedWorkshopTrackId: assignedWorkshopTrackId || 'VIA-07',
      status: 'scheduled',
      externalSystemId: externalSystemId || `EXT-${Date.now().toString().slice(-5)}`,
      systemSource: systemSource || 'SAP PM',
      technicianInCharge: technicianInCharge || 'Engenharia de Manutenção',
      description: description || 'Revisão preventiva programada',
    };

    schedules.unshift(newSchedule);

    // Audit log
    auditLogs.unshift({
      id: `AUDIT-${Date.now().toString().slice(-6)}`,
      timestamp: new Date().toISOString(),
      userId: 'API-INTEGRATION',
      userName: `Conector ${newSchedule.systemSource}`,
      userRole: 'Sistema Externo',
      action: 'CRIAR_AGENDAMENTO_PREVENTIVA',
      entityType: 'schedule',
      entityId: newSchedule.id,
      details: `Ordem ${newSchedule.externalSystemId} para ${newSchedule.vehicleName} sincronizada via API.`,
      clientIp: req.ip || '127.0.0.1',
      device: 'API Gateway',
    });

    broadcastEvent('schedule_updated', { schedule: newSchedule });

    res.status(201).json({ success: true, schedule: newSchedule });
  });

  // Trigger External Sync via API
  app.post('/api/v1/schedules/sync', (req, res) => {
    const { targetSystem = 'SAP PM Gateway v2' } = req.body;
    const nowIso = new Date().toISOString();

    // Create a synchronized preventive schedule to demonstrate live sync
    const syncedVehicle = vehicles[Math.floor(Math.random() * vehicles.length)];
    const newSyncedSchedule: MaintenanceSchedule = {
      id: `SCH-SYNC-${Date.now().toString().slice(-4)}`,
      vehicleId: syncedVehicle.id,
      vehicleName: syncedVehicle.name,
      type: 'Preventiva Sistemática',
      scheduledDate: new Date(Date.now() + 86400000 * 3).toISOString(),
      estimatedDurationHours: 6,
      assignedWorkshopTrackId: 'VIA-07',
      status: 'scheduled',
      externalSystemId: `SAP-ORD-${Math.floor(100000 + Math.random() * 900000)}`,
      systemSource: 'SAP PM',
      technicianInCharge: 'Dra. Beatriz Fontana (Engª)',
      description: 'Sincronizado via Webhook/API: Inspeção periódica de rodados e lubrificação de mancais.',
    };

    schedules.unshift(newSyncedSchedule);

    const alert: NotificationAlert = {
      id: `NOTIF-${Date.now().toString().slice(-6)}`,
      timestamp: nowIso,
      title: 'Sincronização API Realizada com Sucesso',
      message: `Integração com ${targetSystem} sincronizou ordem preventiva para ${syncedVehicle.name}.`,
      severity: 'info',
      category: 'api_sync',
      read: false,
      relatedVehicleId: syncedVehicle.id,
      channelsDispatched: { push: true, email: false, sms: false },
      confirmed: false,
    };
    notifications.unshift(alert);

    auditLogs.unshift({
      id: `AUDIT-${Date.now().toString().slice(-6)}`,
      timestamp: nowIso,
      userId: 'USR-01',
      userName: 'Ricardo Nogueira (Admin)',
      userRole: 'Administrador Geral',
      action: 'SINCRONIZACAO_API_SUCESSO',
      entityType: 'schedule',
      entityId: newSyncedSchedule.id,
      details: `Sincronização bidirecional executada com endpoint ${targetSystem}. 1 nova ordem preventiva injetada.`,
      clientIp: req.ip || '127.0.0.1',
      device: 'API Synchronization Client',
    });

    broadcastEvent('api_sync_completed', {
      schedule: newSyncedSchedule,
      alert,
    });

    res.json({
      success: true,
      timestamp: nowIso,
      syncedOrdersCount: 1,
      targetSystem,
      message: 'Sincronização bidirecional com sistema de agendamento concluída com sucesso.',
      schedule: newSyncedSchedule,
    });
  });

  // 7. Daily Operational Reports (RDO Ferroviário)
  app.get('/api/v1/reports/daily', (req, res) => {
    const queryDate = (req.query.date as string) || new Date().toISOString().split('T')[0];

    // Filter movements of that date
    const dayMovements = movements.filter(m => m.timestamp.startsWith(queryDate));
    const entries = dayMovements.filter(m => m.type === 'entry').length;
    const exits = dayMovements.filter(m => m.type === 'exit').length;
    const internalShunts = dayMovements.filter(m => m.type === 'shunting').length;
    const maintenanceMoves = dayMovements.filter(m => m.type === 'maintenance_in' || m.type === 'maintenance_out').length;

    const totalCapacity = tracks.reduce((acc, t) => acc + ((t.spots && t.spots.length > 0) ? t.spots.length : (t.capacityWagons || 1)), 0);
    const currentOccupied = tracks.reduce((acc, t) => {
      if (t.spots && t.spots.length > 0) {
        return acc + t.spots.filter(s => s.status === 'occupied' || !!s.vehicleId).length;
      }
      return acc + (t.assignedVehicles?.length || 0);
    }, 0);
    const avgOccupancy = totalCapacity > 0 ? Math.round((currentOccupied / totalCapacity) * 100) : 0;

    const report: DailyReportSummary = {
      date: queryDate,
      totalMovements: dayMovements.length || movements.length,
      entries: entries || 4,
      exits: exits || 2,
      internalShunts: internalShunts || 3,
      maintenanceMovements: maintenanceMoves || 2,
      averageOccupancyRate: avgOccupancy,
      peakOccupancyRate: Math.min(100, avgOccupancy + 14),
      averageDwellTimeHours: 14.8,
      preventiveMaintenancesDone: schedules.filter(s => s.status === 'completed' || s.status === 'in_progress').length,
      criticalAlertsResolved: 4,
      busiestTrack: 'VIA-03 (Espera de Linha Sul)',
      activeVehiclesInYard: vehicles.filter(v => v.currentTrackId !== null).length,
      punctualityRatePercent: 96.4,
    };

    res.json({
      report,
      movements: dayMovements.length > 0 ? dayMovements : movements.slice(0, 10),
      tracksSnapshot: tracks.map(t => ({
        id: t.id,
        name: t.name,
        category: t.category,
        capacityWagons: t.capacityWagons,
        occupiedWagons: t.assignedVehicles.length,
        occupancyPct: t.capacityWagons > 0 ? Math.round((t.assignedVehicles.length / t.capacityWagons) * 100) : 0,
        status: t.status,
      })),
    });
  });

  // 8. Real-Time Audit Log
  app.get('/api/v1/audit', (req, res) => {
    const { limit = 50, action, userId } = req.query;
    let filtered = [...auditLogs];

    if (action) {
      filtered = filtered.filter(a => a.action.toLowerCase().includes((action as string).toLowerCase()));
    }
    if (userId) {
      filtered = filtered.filter(a => a.userId === userId);
    }

    res.json({
      total: filtered.length,
      logs: filtered.slice(0, parseInt(limit as string, 10)),
    });
  });

  // 9. Notifications Management
  app.get('/api/v1/notifications', (req, res) => {
    res.json({
      unreadCount: notifications.filter(n => !n.read).length,
      notifications,
    });
  });

  app.post('/api/v1/notifications/:id/read', (req, res) => {
    const { id } = req.params;
    const notif = notifications.find(n => n.id === id);
    if (notif) {
      notif.read = true;
    }
    res.json({ success: true, notif });
  });

  app.post('/api/v1/notifications/mark-all-read', (req, res) => {
    notifications.forEach(n => { n.read = true; });
    res.json({ success: true, count: notifications.length });
  });

  // Confirm / Acknowledge Notification (User requirement: registrar histórico de notificações enviadas e confirmadas)
  app.post('/api/v1/notifications/:id/confirm', (req, res) => {
    const { id } = req.params;
    const { operatorName = 'Operador CCO', notes = 'Alerta verificado e atendido' } = req.body;
    const notif = notifications.find(n => n.id === id);
    if (!notif) {
      return res.status(404).json({ error: 'Notificação não encontrada.' });
    }

    const nowIso = new Date().toISOString();
    notif.confirmed = true;
    notif.confirmedAt = nowIso;
    notif.confirmedBy = operatorName;
    notif.confirmationNotes = notes;
    notif.read = true;

    // Log to Immutable Real-Time Audit Trail
    auditLogs.unshift({
      id: `AUDIT-${Date.now().toString().slice(-6)}`,
      timestamp: nowIso,
      userId: 'CCO-OPERATOR',
      userName: operatorName,
      userRole: 'Despachante / Operador',
      action: 'CONFIRMAR_NOTIFICACAO',
      entityType: 'notification',
      entityId: notif.id,
      details: `Notificação "${notif.title}" confirmada por ${operatorName}. Observação: ${notes}`,
      clientIp: req.ip || '127.0.0.1',
      device: 'Console CCO Ferroviário',
    });

    broadcastEvent('notification_confirmed', { notif });

    res.json({ success: true, notif });
  });

  // 10. Customizable Notification Rules (Configurações personalizáveis solicitadas pelo usuário)
  app.get('/api/v1/rules', (req, res) => {
    res.json({
      total: rules.length,
      rules,
    });
  });

  app.post('/api/v1/rules', (req, res) => {
    const {
      name,
      description,
      eventType,
      criteria,
      channels,
      recipients,
    } = req.body;

    const newRule: NotificationRule = {
      id: `RULE-${Date.now().toString().slice(-4)}`,
      name: name || 'Nova Regra de Alerta',
      description: description || 'Regra personalizada de monitoramento ferroviário',
      eventType: eventType || 'cargo_arrival',
      criteria: criteria || {},
      channels: channels || { pushApp: true, email: false, sms: false },
      recipients: recipients || { roles: ['cco_dispatcher'], emails: '', phones: '' },
      isActive: true,
      triggerCount: 0,
    };

    rules.unshift(newRule);

    auditLogs.unshift({
      id: `AUDIT-${Date.now().toString().slice(-6)}`,
      timestamp: new Date().toISOString(),
      userId: 'USR-ADMIN',
      userName: 'Administrador do Sistema',
      userRole: 'admin',
      action: 'CRIAR_REGRA_ALERTA',
      entityType: 'system',
      entityId: newRule.id,
      details: `Criada regra de alerta "${newRule.name}" para evento ${newRule.eventType}. Canais: Push (${newRule.channels.pushApp}), Email (${newRule.channels.email}), SMS (${newRule.channels.sms}).`,
      clientIp: req.ip || '127.0.0.1',
      device: 'Console Admin',
    });

    broadcastEvent('rules_updated', { rules });
    res.status(201).json({ success: true, rule: newRule });
  });

  app.put('/api/v1/rules/:id', (req, res) => {
    const { id } = req.params;
    const ruleIndex = rules.findIndex(r => r.id === id);
    if (ruleIndex === -1) {
      return res.status(404).json({ error: 'Regra de alerta não encontrada.' });
    }

    rules[ruleIndex] = {
      ...rules[ruleIndex],
      ...req.body,
    };

    broadcastEvent('rules_updated', { rules });
    res.json({ success: true, rule: rules[ruleIndex] });
  });

  app.delete('/api/v1/rules/:id', (req, res) => {
    const { id } = req.params;
    rules = rules.filter(r => r.id !== id);
    broadcastEvent('rules_updated', { rules });
    res.json({ success: true });
  });

  // Simulate Rule Trigger / Test Dispatch (Allows testing push, email, and SMS in real time)
  app.post('/api/v1/rules/:id/trigger-test', (req, res) => {
    const { id } = req.params;
    const rule = rules.find(r => r.id === id);
    if (!rule) {
      return res.status(404).json({ error: 'Regra de alerta não encontrada.' });
    }

    const nowIso = new Date().toISOString();
    rule.triggerCount += 1;
    rule.lastTriggeredAt = nowIso;

    // Compose custom notification alert matching rule specifications
    const testAlert: NotificationAlert = {
      id: `NOTIF-${Date.now().toString().slice(-6)}`,
      timestamp: nowIso,
      title: `[ALERTA REGRA] ${rule.name}`,
      message: `Disparo automático de alerta conforme regra configurada: ${rule.description}`,
      severity: rule.eventType === 'cargo_arrival' || rule.eventType === 'track_restriction' ? 'warning' : 'info',
      category: rule.eventType === 'cargo_arrival' ? 'cargo' : rule.eventType === 'zone_occupancy' ? 'occupancy' : 'safety',
      read: false,
      channelsDispatched: {
        push: rule.channels.pushApp,
        email: rule.channels.email,
        sms: rule.channels.sms,
      },
      recipientsSummary: [
        rule.channels.pushApp ? 'App Push' : null,
        rule.channels.email ? `Email (${rule.recipients.emails || 'operacao@ferropatio.com.br'})` : null,
        rule.channels.sms ? `SMS (${rule.recipients.phones || '+55 11 98888-7711'})` : null,
      ].filter(Boolean).join(' + '),
      confirmed: false,
      ruleId: rule.id,
    };

    notifications.unshift(testAlert);

    auditLogs.unshift({
      id: `AUDIT-${Date.now().toString().slice(-6)}`,
      timestamp: nowIso,
      userId: 'SISTEMA-ALERTAS',
      userName: 'Motor de Notificações CCO',
      userRole: 'Sistema Automático',
      action: 'DISPARAR_ALERTA_CANAL',
      entityType: 'notification',
      entityId: testAlert.id,
      details: `Disparo de alerta para ${testAlert.recipientsSummary}. Canais ativados: Push=${rule.channels.pushApp}, Email=${rule.channels.email}, SMS=${rule.channels.sms}.`,
      clientIp: req.ip || '127.0.0.1',
      device: 'CCO Push/Email/SMS Gateway',
    });

    broadcastEvent('new_notification', { alert: testAlert });
    broadcastEvent('rules_updated', { rules });

    res.json({
      success: true,
      alert: testAlert,
      channelsDispatched: testAlert.channelsDispatched,
      message: `Alerta disparado com sucesso através dos canais configurados (${testAlert.recipientsSummary}).`,
    });
  });

  // 11. Spot Status Update (Liberar, Ocupar, Manutenção, Restrição)
  app.put('/api/v1/spots/:id/status', (req, res) => {
    const { id } = req.params;
    const { status, restrictionReason, vehicleId } = req.body;

    let targetSpot: any = null;
    let targetTrack: any = null;
    for (const track of tracks) {
      const sp = track.spots?.find(s => s.id === id);
      if (sp) {
        targetSpot = sp;
        targetTrack = track;
        break;
      }
    }

    if (!targetSpot || !targetTrack) {
      return res.status(404).json({ error: 'Vaga não encontrada.' });
    }

    targetSpot.status = status;
    targetSpot.restrictionReason = status === 'restricted' ? (restrictionReason || 'Interdição de via') : undefined;

    if (status === 'free') {
      const prevVehId = targetSpot.vehicleId;
      targetSpot.vehicleId = null;
      if (prevVehId) {
        const v = vehicles.find(veh => veh.id === prevVehId);
        if (v) {
          v.currentSpotId = undefined;
        }
        targetTrack.assignedVehicles = (targetTrack.assignedVehicles || []).filter((vid: string) => vid !== prevVehId);
      }
    } else if (status === 'occupied') {
      if (vehicleId) {
        targetSpot.vehicleId = vehicleId;
        const v = vehicles.find(veh => veh.id === vehicleId);
        if (v) {
          tracks.forEach(tr => {
            tr.assignedVehicles = (tr.assignedVehicles || []).filter((vid: string) => vid !== vehicleId);
            tr.spots?.forEach(sp => {
              if (sp.id !== targetSpot.id && sp.vehicleId === vehicleId) {
                sp.vehicleId = null;
                sp.status = 'free';
              }
            });
          });
          v.currentTrackId = targetTrack.id;
          v.currentSpotId = targetSpot.id;
          if (!targetTrack.assignedVehicles.includes(v.id)) {
            targetTrack.assignedVehicles.push(v.id);
          }
        }
      }
    }

    broadcastEvent('spot_updated', { spot: targetSpot, tracks, vehicles });
    saveDbState();
    res.json({ success: true, spot: targetSpot, tracks, vehicles });
  });

  // 10. Real-time Server-Sent Events (SSE) Stream
  app.get('/api/v1/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (isServerless) {
      // In serverless platforms like Netlify/AWS Lambda, long-lived streaming connections time out.
      // Send single welcome event and close cleanly so the Lambda does not hang or error out.
      res.write(`event: connected\ndata: ${JSON.stringify({ isServerless: true, timestamp: new Date().toISOString() })}\n\n`);
      return res.end();
    }

    res.flushHeaders();

    const clientId = `client-${Date.now()}-${Math.random()}`;
    const newClient: SSEClient = { id: clientId, res };
    sseClients.push(newClient);

    // Initial heartbeat and welcome
    res.write(`event: connected\ndata: ${JSON.stringify({ clientId, timestamp: new Date().toISOString() })}\n\n`);

    req.on('close', () => {
      const idx = sseClients.findIndex(c => c.id === clientId);
      if (idx !== -1) {
        sseClients.splice(idx, 1);
      }
    });
  });

  // 11. Storage Continuous Memory Synchronization Endpoints
  app.get('/api/v1/storage/status', (req, res) => {
    res.json({
      persisted: true,
      movementsCount: movements.length,
      vehiclesCount: vehicles.length,
      tracksCount: tracks.length,
      lastSaved: new Date().toISOString(),
    });
  });

  app.post('/api/v1/storage/sync', (req, res) => {
    const { 
      tracks: inTracks, 
      vehicles: inVehicles, 
      movements: inMovements, 
      auditLogs: inAuditLogs, 
      schedules: inSchedules,
      users: inUsers
    } = req.body;

    let updated = false;

    if (Array.isArray(inMovements) && inMovements.length > 0) {
      if (inMovements.length >= movements.length) {
        movements = inMovements;
        updated = true;
      }
    }

    if (Array.isArray(inTracks) && inTracks.length > 0) {
      tracks = inTracks;
      updated = true;
    }

    if (Array.isArray(inVehicles) && inVehicles.length > 0) {
      // Merge vehicles preserving operational phone if set either in memory or payload
      vehicles = inVehicles.map(iv => {
        const existing = vehicles.find(v => v.id.toLowerCase() === iv.id.toLowerCase());
        return {
          ...iv,
          hasOperationalPhone: iv.hasOperationalPhone !== undefined 
            ? iv.hasOperationalPhone 
            : (existing ? existing.hasOperationalPhone : false),
          operationalPhoneNotes: iv.operationalPhoneNotes !== undefined 
            ? iv.operationalPhoneNotes 
            : (existing ? existing.operationalPhoneNotes : undefined),
        };
      });
      // also ensure any existing vehicles not present in inVehicles are retained
      for (const ev of vehicles) {
        if (!inVehicles.some(iv => iv.id.toLowerCase() === ev.id.toLowerCase())) {
          inVehicles.push(ev);
        }
      }
      updated = true;
    }

    if (Array.isArray(inAuditLogs) && inAuditLogs.length >= auditLogs.length) {
      auditLogs = inAuditLogs;
      updated = true;
    }

    if (Array.isArray(inSchedules) && inSchedules.length >= schedules.length) {
      schedules = inSchedules;
      updated = true;
    }

    // Bidirectional sync for users from persistent client backup
    if (Array.isArray(inUsers) && inUsers.length > 0) {
      let usersMerged = false;
      for (const u of inUsers) {
        if (!users.some(existing => existing.id === u.id || matchUserBadge(u.badgeNumber, existing.badgeNumber))) {
          users.push(u);
          usersMerged = true;
        }
      }
      if (usersMerged) {
        saveUsersToDisk();
        updated = true;
      }
    }

    if (updated) {
      saveDbState();
      broadcastEvent('yard_state_restored', { tracks, vehicles, movements });
      console.log(`[Storage Sync] Estado do pátio sincronizado com o cliente (${movements.length} movimentos restaurados, ${users.length} operadores).`);
    }

    res.json({
      success: true,
      restored: updated,
      movementsCount: movements.length,
      vehiclesCount: vehicles.length,
      tracksCount: tracks.length,
      usersCount: users.length,
      lastSaved: new Date().toISOString(),
    });
  });

  // 12. Unified User Profiles & Role-Based Access Database (Synchronized across Windows & Mobile)
  app.get('/api/v1/users', (req, res) => {
    res.json({ users });
  });

  // Register or create user in unified database
  app.post('/api/v1/users', (req, res) => {
    try {
      const userPayload = req.body.user || req.body;
      const clientDevice = req.body.clientDevice || userPayload.createdDevice;

      if (!userPayload || !userPayload.name || !userPayload.badgeNumber) {
        return res.status(400).json({ error: 'Dados do operador incompletos (nome e matrícula são obrigatórios).' });
      }

      const { deviceString, deviceType } = parseDevice(req.headers['user-agent'], clientDevice);
      const normalizedBadge = formatBadgeNumber(userPayload.badgeNumber);
      const existingIndex = users.findIndex(
        u => (userPayload.id && u.id === userPayload.id) || matchUserBadge(userPayload.badgeNumber, u.badgeNumber)
      );

      let savedUser: UserProfile;

      if (existingIndex >= 0) {
        // Update existing user
        savedUser = {
          ...users[existingIndex],
          ...userPayload,
          name: userPayload.name.trim(),
          badgeNumber: normalizedBadge,
          lastLoginDevice: deviceString,
        };
        users[existingIndex] = savedUser;
      } else {
        // Create new user in unified database
        const userId = userPayload.id || `USR-${Date.now().toString().slice(-6)}`;
        savedUser = {
          id: userId,
          name: userPayload.name.trim(),
          role: userPayload.role || 'controlador_cco',
          roleLabel: userPayload.roleLabel || (
            userPayload.role === 'tecnico_mro' ? 'Técnico de Manutenção MRO' : 
            userPayload.role === 'supervisor_cco' ? 'Supervisor de Turno CCO' : 
            'Controlador de Tráfego CCO'
          ),
          badgeNumber: normalizedBadge,
          department: userPayload.department || 'Operações Ferroviárias VLT',
          avatar: userPayload.avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
          password: userPayload.password || '123',
          createdAt: userPayload.createdAt || new Date().toISOString(),
          createdDevice: deviceString,
          deviceType: deviceType,
          lastLoginAt: new Date().toISOString(),
          lastLoginDevice: deviceString,
        };
        users.unshift(savedUser);

        // Audit log entry for new operator registration
        const auditEntry: AuditLogEntry = {
          id: `AUD-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
          timestamp: new Date().toISOString(),
          userId: savedUser.id,
          userName: savedUser.name,
          userRole: savedUser.roleLabel,
          action: 'CADASTRO_OPERADOR',
          entityType: 'auth',
          entityId: savedUser.id,
          details: `Novo operador cadastrado no banco de dados unificado: "${savedUser.name}" (${savedUser.badgeNumber} - ${savedUser.roleLabel}) originado via ${deviceString}.`,
          device: deviceString,
        };
        auditLogs.unshift(auditEntry);
        if (auditLogs.length > 500) auditLogs.pop();
      }

      // Save directly to isolated disk storage and main yard database
      saveUsersToDisk();
      saveDbState();

      // Real-time synchronization broadcast across all connected Windows & Mobile devices
      broadcastEvent('users_updated', { 
        users, 
        action: existingIndex >= 0 ? 'updated' : 'created',
        user: savedUser,
        sourceDevice: deviceString 
      });

      console.log(`[Unified DB] Operador persistido com sucesso no banco de dados: "${savedUser.name}" (${savedUser.badgeNumber}) via ${deviceString}. Total: ${users.length}`);
      res.json({ success: true, user: savedUser, users });
    } catch (e: any) {
      console.error('[Unified DB Error] Falha ao cadastrar operador:', e);
      res.status(500).json({ error: 'Erro interno ao salvar operador no banco de dados unificado.' });
    }
  });

  // Login authentication against unified database with flexible matching
  app.post('/api/v1/auth/login', (req, res) => {
    try {
      const { badgeNumber, password, clientDevice } = req.body;
      if (!badgeNumber || !badgeNumber.toString().trim()) {
        return res.status(400).json({ error: 'Matrícula ou identificação do operador é obrigatória.' });
      }

      const searchBadge = badgeNumber.toString().trim();
      const user = users.find(u => matchUserBadge(searchBadge, u.badgeNumber, u.name, u.id));

      if (!user) {
        console.warn(`[Login Failed] Nenhum operador localizado para o termo: "${searchBadge}". Operadores cadastrados no banco:`, users.map(u => `${u.name} (${u.badgeNumber})`));
        return res.status(404).json({ 
          error: `Nenhum operador localizado com "${searchBadge}" no banco de dados. Realize o cadastro na aba "Primeiro Acesso".`,
          availableCount: users.length
        });
      }

      if (user.password && password && user.password !== password.toString().trim()) {
        return res.status(401).json({ error: 'Senha incorreta para a matrícula informada.' });
      }

      const { deviceString } = parseDevice(req.headers['user-agent'], clientDevice);
      user.lastLoginAt = new Date().toISOString();
      user.lastLoginDevice = deviceString;

      saveUsersToDisk();
      saveDbState();

      // Audit log entry for login
      const auditEntry: AuditLogEntry = {
        id: `AUD-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        timestamp: new Date().toISOString(),
        userId: user.id,
        userName: user.name,
        userRole: user.roleLabel || user.role,
        action: 'LOGIN_OPERADOR',
        entityType: 'auth',
        entityId: user.id,
        details: `Operador "${user.name}" (${user.badgeNumber}) efetuou login no sistema via ${deviceString}.`,
        device: deviceString,
      };
      auditLogs.unshift(auditEntry);
      if (auditLogs.length > 500) auditLogs.pop();

      broadcastEvent('users_updated', { users, action: 'login', user, sourceDevice: deviceString });

      console.log(`[Auth Success] Login realizado com sucesso para: ${user.name} (${user.badgeNumber}) via ${deviceString}.`);
      res.json({ success: true, user, users });
    } catch (e: any) {
      console.error('[Auth Error] Falha ao processar login:', e);
      res.status(500).json({ error: 'Erro ao processar login.' });
    }
  });

  // Delete operator profile from unified database (Restricted to Supervisor CCO)
  app.delete('/api/v1/users/:id', (req, res) => {
    try {
      const { id } = req.params;
      const { supervisorUser, reason } = req.body;

      // 1. Permission Check: Requesting user must be a Supervisor of CCO or Admin
      const isSupervisorAuthorized = supervisorUser && (
        supervisorUser.role === 'supervisor_cco' || 
        supervisorUser.role === 'admin'
      );

      if (!isSupervisorAuthorized) {
        return res.status(403).json({ 
          error: 'ACESSO NEGADO: Apenas o Supervisor de CCO tem autorização para gerenciar e excluir perfis do banco de dados unificado.' 
        });
      }

      // 2. Find target user
      const targetIndex = users.findIndex(u => u.id === id);
      if (targetIndex < 0) {
        return res.status(404).json({ error: 'Perfil de operador não localizado no banco de dados unificado.' });
      }

      const deletedUser = users[targetIndex];

      // 3. System Safety Rule: Cannot delete the last remaining Supervisor of CCO
      const totalSupervisors = users.filter(u => u.role === 'supervisor_cco' || u.role === 'admin').length;
      if ((deletedUser.role === 'supervisor_cco' || deletedUser.role === 'admin') && totalSupervisors <= 1) {
        return res.status(400).json({ 
          error: 'Operação de segurança bloqueada! Não é permitido excluir o único Supervisor de CCO ativo no sistema.' 
        });
      }

      // 4. Check if deleted user is currently the active Manobrador
      if (activeManobrador && activeManobrador.userId === deletedUser.id) {
        activeManobrador = null;
        broadcastEvent('manobrador_changed', { activeManobrador: null });
      }

      // 5. Delete user from unified database
      users.splice(targetIndex, 1);

      // 6. Record official audit log
      const { deviceString } = parseDevice(req.headers['user-agent']);
      const auditEntry: AuditLogEntry = {
        id: `AUD-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        timestamp: new Date().toISOString(),
        userId: supervisorUser.id || 'SUPERVISOR-CCO',
        userName: supervisorUser.name || 'Supervisor CCO',
        userRole: supervisorUser.roleLabel || 'Supervisor de CCO',
        action: 'EXCLUSAO_PERFIL',
        entityType: 'auth',
        entityId: deletedUser.id,
        details: `EXCLUSÃO DE PERFIL: O Supervisor CCO ${supervisorUser.name} (${supervisorUser.badgeNumber}) excluiu permanentemente o perfil do operador "${deletedUser.name}" (Matrícula: ${deletedUser.badgeNumber}, Perfil: ${deletedUser.roleLabel})${reason ? `. Motivo: ${reason}` : ''}.`,
        device: deviceString,
      };
      auditLogs.unshift(auditEntry);
      if (auditLogs.length > 500) auditLogs.pop();

      // 7. Persist to continuous database file
      saveDbState();

      // 8. Real-time broadcast to all Windows and Mobile clients
      broadcastEvent('users_updated', { 
        users, 
        action: 'deleted', 
        deletedUserId: id, 
        deletedUserName: deletedUser.name,
        supervisorName: supervisorUser.name 
      });

      console.log(`[Unified DB] Perfil de operador ${deletedUser.name} (${deletedUser.badgeNumber}) excluído pelo Supervisor CCO ${supervisorUser.name}.`);
      res.json({ 
        success: true, 
        message: `Perfil do operador ${deletedUser.name} (${deletedUser.badgeNumber}) excluído com sucesso do banco de dados unificado.`,
        users 
      });
    } catch (e: any) {
      console.error('[Unified DB Error] Falha ao excluir operador:', e);
      res.status(500).json({ error: 'Erro interno ao excluir perfil do operador.' });
    }
  });

  // Update profile by Supervisor CCO
  app.put('/api/v1/users/:id', (req, res) => {
    try {
      const { id } = req.params;
      const { supervisorUser, updateData } = req.body;

      const isSupervisorAuthorized = supervisorUser && (
        supervisorUser.role === 'supervisor_cco' || 
        supervisorUser.role === 'admin'
      );

      if (!isSupervisorAuthorized) {
        return res.status(403).json({ 
          error: 'Apenas o Supervisor de CCO tem autorização para editar perfis.' 
        });
      }

      const targetIndex = users.findIndex(u => u.id === id);
      if (targetIndex < 0) {
        return res.status(404).json({ error: 'Perfil não encontrado.' });
      }

      const updated = {
        ...users[targetIndex],
        ...updateData,
        id, // preserve id
      };
      users[targetIndex] = updated;

      saveDbState();

      broadcastEvent('users_updated', { users, action: 'updated', user: updated });

      res.json({ success: true, user: updated, users });
    } catch (e: any) {
      res.status(500).json({ error: 'Erro ao atualizar perfil.' });
    }
  });

  return app;
}
