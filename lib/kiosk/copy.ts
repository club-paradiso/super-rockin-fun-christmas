import type { CameraErrorKind } from "@/lib/camera/types";

/**
 * Every guest-facing booth string, in Korean, English and Chinese (D78, D89). The guest picks the
 * language on the first screen; the next guest starts in Korean again (lib/kiosk/machine.ts
 * `lang`). Chinese is Simplified (简体中文).
 *
 * The Korean strings are the user's own wording (D76): do not reword them here. Staff-only text
 * (help mode, status badges) stays Korean and is not in this file. Line breaks are "\n" and are
 * rendered by the screens.
 */
export type KioskLang = "ko" | "en" | "zh";
export const KIOSK_LANGS: readonly KioskLang[] = ["ko", "en", "zh"];

/** The value for `<html lang>`: Simplified Chinese glyphs need the script subtag. */
export const HTML_LANG: Record<KioskLang, string> = { ko: "ko", en: "en", zh: "zh-Hans" };

const ko = {
  langName: "한국어",
  langGroup: "언어 · Language",
  /** Booth sound switch (Claude's wording, not D76: check with the user). */
  sound: "소리",
  /** The stamp ticket. The number comes from the server, or is left off. */
  ticket: {
    dayOrdinal: (n: number) => `오늘 ${n}번째 기록`,
    dayRecord: "오늘의 기록",
  },
  /** The attract screen (D80). The guest has not chosen a language yet: it shows both. */
  attract: {
    start: "화면을 눌러 시작",
    event: "Christmas Village 2026",
  },
  welcome: {
    title: "크리스마스의 추억을 함께 남겨요",
    lead: "사진을 찍어 휴대폰으로 받거나, 내 사진을 보내 큰 화면에 함께 걸어요.",
    camera: "여기서 사진 찍기",
    cameraLead: "여섯 장 찍고 골라서 휴대폰으로 받아요",
    mobile: "내 사진으로 참여하기",
    mobileLead: "휴대폰에 있는 사진을 미디어월로 보내요",
    paused: "미디어월 게시 신청을 잠시 멈췄어요. 사진 찍기는 지금도 할 수 있어요",
  },
  chrome: {
    back: "이전",
    home: "처음으로",
  },
  steps: {
    of: (step: number, total: number) => `${total}단계 중 ${step}단계`,
  },
  frame: {
    pickTitle: "어떤 틀로 찍을까요?",
    next: "다음",
    shoot: "이 틀로 찍기",
    slots: (n: number) => `${n}컷 템플릿`,
  },
  /**
   * The phone page's frame step (app/m/[token], D103). These were the booth's words before
   * 「틀 선택 v2」; the phone flow keeps them unchanged.
   */
  phoneFrame: {
    pickTitle: "마음에 드는 틀을 골라주세요",
    confirm: "이 틀로 할게요",
    changeFrame: "프레임 바꾸기",
  },
  name: {
    film3: "필름 3컷",
    film4: "필름 4컷",
    polaroid1: "폴라로이드 1컷",
    polaroid3: "폴라로이드 3컷",
    verse4: "성경 구절 4컷",
    check2: "체크 2컷",
    lace1: "레이스 1컷",
    film35: "35mm 필름 4컷",
  },
  hint: {
    film3: "색·로고 선택",
    film4: "크림·빨강 선택",
    check2: "빨강·파랑 선택",
    film35: "컬러·흑백·세피아",
  },
  option: {
    titleColorLogo: "색과 로고를 골라주세요",
    titleColor: "색을 골라주세요",
    locked: (frame: string) => `${frame} · 찍은 뒤에는 바꿀 수 없어요`,
    shoot: "이대로 찍기",
  },
  label: {
    color: "색",
    logo: "로고",
  },
  value: {
    mono: "흑백",
    sepia: "세피아",
    logoOn: "넣기",
    logoOff: "빼기",
    cream: "크림",
    red: "빨강",
    blue: "파랑",
    natural: "컬러",
  },
  camera: {
    startingTitle: "카메라를 켜고 있어요",
    startingLead: "허용을 묻는 창이 뜨면 ‘허용’을 눌러 주세요.",
    preview: "미리보기를 준비하고 있어요…",
    retry: "다시 시도",
    home: "처음으로",
    choose: "카메라",
    defaultDevice: "기본 카메라",
    errors: {
      denied: {
        title: "카메라 사용이 허용되지 않았어요",
        // Figma KIOSK 3e (395:1351), chosen by the user on 2026-11-23 (D113).
        lead: "브라우저에서 카메라 사용을 허용한 후 다시 시도해 주세요.\n어렵다면 안내 도우미에게 알려 주세요.",
      },
      missing: {
        title: "카메라를 찾을 수 없어요",
        lead: "카메라 연결을 확인한 뒤 다시 시도해 주세요.",
      },
      unsupported: {
        title: "이 화면에서는 카메라를 쓸 수 없어요",
        lead: "HTTPS 주소 또는 지원되는 브라우저에서 열어야 해요. 도우미에게 알려 주세요.",
      },
      failed: { title: "카메라가 잠시 멈췄어요", lead: "다시 시도를 눌러 주세요." },
    } satisfies Record<CameraErrorKind, { title: string; lead: string }>,
  },
  shoot: {
    shot: (n: number) => `${n}번째 사진`,
    flashOn: "화면 플래시 켜기",
    flashOff: "화면 플래시 끄기",
    lead: "카메라를 보고 웃어주세요.\n숫자가 0이 되면 찍혀요.",
    free: "자유 포즈로 찍기",
    guide: "포즈 추천받고 찍기",
    plan: (seconds: number, total: number) => `${seconds}초마다 한 컷씩, 모두 ${total}컷을 찍어요`,
    // Figma KIOSK 3b (395:1204), chosen by the user on 2026-11-23 (D113).
    video: "촬영 과정은 소리 없이 짧은 영상으로도 저장돼요.",
    pose: "추천 포즈",
    progress: (done: number, total: number) => `${total}장 중 ${done}장 촬영`,
  },
  review: {
    title: "잘 나왔나요?",
    confirm: "이대로 좋아요",
  },
  select: {
    title: (required: number, total: number) => `${total}장 중 ${required}장을 골라주세요`,
    lead: (selected: number, required: number) =>
      `선택한 순서대로 프레임에 들어가요. ${selected} / ${required}장 선택했어요.`,
    choose: (n: number) => `${n}번째 사진 선택`,
    unchoose: (n: number) => `${n}번째 사진 선택 해제`,
    confirm: "이 사진으로 완성하기",
    // The colour row (2026-11-24, Figma 956:1589). Written by Claude as placeholders on the
    // user's instruction to build it first: the user's own wording replaces these (D76).
    lookTitle: "색감",
    lookNext: "다음",
    lookPrev: "이전",
    lookChoose: (name: string) => `${name} 색감으로 바꾸기`,
    looks: {
      paper: "페이퍼",
      linen: "리넨",
      lamp: "램프",
      pine: "파인",
      album: "앨범",
      flash: "플래시",
      ink: "잉크",
      walnut: "월넛",
    } as Record<string, string>,
  },
  consent: {
    title: "이 사진을 미디어월에\n띄워도 될까요?",
    lead: "미디어월에 다른 분들 사진과 함께 돌아가며 보여요.\n아니요를 눌러도 사진은 받을 수 있어요.",
    yes: "네, 띄워주세요",
    no: "아니요, 저만 볼게요",
    // The third line (D96) was written by Claude (2026-11-14) on the user's instruction to tell
    // guests that staff can hide a photo; the first two are the user's wording (D76).
    note: "사진은 정해진 기간이 지나면 지워져요.\n띄운 뒤에도 안내 봉사자에게 말하면 바로 내려드려요.\n화면에 어울리지 않는 사진은 운영팀이 숨길 수 있어요.",
    // D86, shown only while staff have the public wall on. Written by Claude (2026-11-13), not
    // yet the user's wording (D76): it has to say plainly that the wall is also on the internet.
    publicNote: "미디어월은 행사장 화면과 온라인 주소에서 함께 보여요.",
    finished: "완성된 사진",
    making: "사진을 만들고 있어요",
  },
  delivery: {
    title: "휴대폰으로 사진을 받아 가세요",
    lead: "휴대폰 카메라로 QR을 비춰 주세요.",
    onWall: "잠시 뒤 큰 화면에서 내 사진을 찾아보세요.",
    // D95: what the booth says while the automatic check runs. The user's wording (mission brief).
    reviewChecking: "사진을 확인하고 있어요. 잠시만 기다려 주세요.",
    reviewDelayed: "사진 확인이 조금 지연되고 있어요. 안전하게 확인한 뒤 화면에 표시할게요.",
    done: "다 받았어요",
    resetSoon: "잠시 뒤 처음 화면으로 돌아가요",
    qrNote: "휴대폰으로 찍으면\n사진 파일을 받을 수 있어요",
    session: (code: string) => `세션 ${code}`,
    pendingTitle: "QR을 준비하고 있어요",
    pendingLead:
      "사진은 안전하게 저장했어요. 인터넷이 조금 느려서 QR이 늦어지고 있어요.\n잠시만 기다리면 이 화면에 QR이 나와요.",
    withoutQr: "QR 없이 처음으로",
    authTitle: "도우미를 불러 주세요",
    authLead: "이 기기 등록이 필요해요. 사진은 이 기기에 안전하게 보관 중이에요.",
    queuedTitle: "사진을 보내고 있어요",
    queuedLead:
      "사진은 이 기기에 안전하게 저장했어요.\n연결되면 자동으로 보내고 QR을 보여 드릴게요.",
    retry: "다시 시도",
    failedTitle: "사진을 보내지 못했어요",
    temporaryQueue: "사진이 이 화면에만 임시로 보관돼요. 화면을 닫지 말고 도우미에게 알려 주세요.",
    // Figma KIOSK 8e (396:1569), chosen by the user on 2026-11-23 (D113).
    failedLead: "화면을 안내 도우미에게 보여 주세요.\n전송 상태를 확인할 수 있도록 도와드릴게요.",
    home: "처음으로",
    sendingTitle: "사진을 보내고 있어요",
    sendingLead: "잠시만 기다려 주세요.",
  },
  mobile: {
    receivedTitle: "사진이 도착했어요",
    receivedLead:
      "운영팀이 확인한 뒤 미디어월에 걸어 드려요.\n확인에는 시간이 조금 걸릴 수 있어요.",
    home: "처음으로",
    retry: "다시 시도",
    failed: {
      offline: {
        title: "지금은 인터넷이 연결되지 않았어요",
        lead: "내 사진 보내기는 인터넷이 필요해요. 사진 찍기는 지금도 할 수 있어요.",
      },
      // Figma KIOSK M4 (396:1705), chosen by the user on 2026-11-23 (D113).
      paused: {
        title: "지금은 사진 접수를 잠시 멈췄어요",
        lead: "잠시 뒤 다시 시도해 주세요. 사진 찍기는 지금도 할 수 있어요.",
      },
      error: { title: "QR을 만들지 못했어요", lead: "다시 시도를 눌러 주세요." },
    },
    title: "휴대폰으로 QR을 찍어 주세요",
    stepsLabel: "순서",
    // The three steps are the Figma screen's wording (KIOSK 「M1 · 내 사진으로 참여하기 · QR」,
    // 396:1633), which has no note under the QR card: the old "운영팀이 확인한 사진만 …" line
    // was removed on 2026-11-23 to match it.
    steps: [
      "휴대폰으로 QR을 찍고 원하는 틀을 골라요",
      "사진을 틀의 칸 수만큼, 들어갈 순서대로 골라요",
      "미디어월 공개 여부를 선택하고 완성 사진을 저장해요",
    ],
    lan: "휴대폰이 행사장 와이파이에 연결되어 있어야 열려요.",
    making: "QR을 만들고 있어요…",
    waiting: "사진이 도착하면\n이 화면이 바뀌어요",
  },
  idle: {
    warning: (seconds: number) =>
      `${seconds}초 뒤 처음 화면으로 돌아가요. 계속하려면 화면을 눌러 주세요.`,
    stay: "계속할게요",
  },
  home: {
    title: "처음 화면으로 갈까요?",
    lead: "지금까지 찍은 사진은 지워지고 저장되지 않아요.",
    stay: "계속 찍을게요",
    leave: "처음으로 갈게요",
  },
};

export type KioskCopy = typeof ko;

const en: KioskCopy = {
  langName: "English",
  langGroup: "언어 · Language",
  sound: "Sound",
  ticket: {
    dayOrdinal: (n) => `Today's record No. ${n}`,
    dayRecord: "Today's record",
  },
  attract: {
    start: "Tap the screen to start",
    event: "Christmas Village 2026",
  },
  welcome: {
    title: "Make a Christmas memory together",
    lead: "Take photos and get them on your phone, or send your own photo to hang on the big screen.",
    camera: "Take photos here",
    // Figma KIOSK 1c (391:491), chosen by the user on 2026-11-23 (D113).
    cameraLead: "Take photos, and get them on your phone",
    mobile: "Share a photo from your phone",
    mobileLead: "Send a photo from your phone to the media wall",
    paused: "Media wall submissions are paused right now. You can still take photos here",
  },
  chrome: {
    back: "Back",
    home: "Start over",
  },
  steps: {
    of: (step, total) => `Step ${step} of ${total}`,
  },
  frame: {
    pickTitle: "Pick a frame",
    next: "Next",
    shoot: "Use this frame",
    slots: (n) => `${n}-photo frame`,
  },
  /**
   * The phone page's frame step (app/m/[token], D103). These were the booth's words before
   * 「틀 선택 v2」; the phone flow keeps them unchanged.
   */
  phoneFrame: {
    pickTitle: "Choose a frame you like",
    confirm: "Go with this frame",
    changeFrame: "Change frame",
  },
  name: {
    film3: "Film · 3 shots",
    film4: "Film · 4 shots",
    polaroid1: "Polaroid · 1 shot",
    polaroid3: "Polaroid · 3 shots",
    verse4: "Bible verse · 4 shots",
    check2: "Plaid · 2 shots",
    lace1: "Lace · 1 shot",
    film35: "35mm film · 4 shots",
  },
  hint: {
    film3: "Color & logo",
    film4: "Cream or red",
    check2: "Red or blue",
    film35: "Color, B&W or sepia",
  },
  option: {
    titleColorLogo: "Choose color and logo",
    titleColor: "Choose a color",
    locked: (frame) => `${frame} · Can't be changed after shooting`,
    shoot: "Start shooting",
  },
  label: {
    color: "Color",
    logo: "Logo",
  },
  value: {
    mono: "B&W",
    sepia: "Sepia",
    logoOn: "On",
    logoOff: "Off",
    cream: "Cream",
    red: "Red",
    blue: "Blue",
    natural: "Color",
  },
  camera: {
    startingTitle: "Turning on the camera",
    startingLead: "If a window asks for permission, tap “Allow.”",
    preview: "Getting the preview ready…",
    retry: "Try again",
    home: "Start over",
    choose: "Camera",
    defaultDevice: "Default camera",
    errors: {
      denied: {
        title: "Camera access isn’t allowed",
        lead: "Allow the camera in the browser, then try again.\nIf that doesn’t work, please tell a helper.",
      },
      missing: {
        title: "We can’t find the camera",
        lead: "Check that the camera is connected, then try again.",
      },
      unsupported: {
        title: "The camera can’t be used on this screen",
        lead: "It needs an HTTPS address or a supported browser. Please tell a helper.",
      },
      failed: { title: "The camera stopped for a moment", lead: "Tap “Try again.”" },
    },
  },
  shoot: {
    shot: (n) => `Photo ${n}`,
    flashOn: "Turn screen flash on",
    flashOff: "Turn screen flash off",
    lead: "Look at the camera and smile.\nThe photo is taken when the count reaches 0.",
    free: "Pose freely",
    guide: "Get pose ideas",
    plan: (seconds, total) => `One photo every ${seconds} seconds, ${total} in all`,
    video: "A short silent clip of the session is saved too.",
    pose: "Try this pose",
    progress: (done, total) => `${done} of ${total} photos taken`,
  },
  review: {
    title: "How did they turn out?",
    confirm: "Looks good",
  },
  select: {
    title: (required, total) => `Pick ${required} of your ${total} photos`,
    lead: (selected, required) =>
      `They go into the frame in the order you pick them. ${selected} of ${required} picked.`,
    choose: (n) => `Pick photo ${n}`,
    unchoose: (n) => `Unpick photo ${n}`,
    confirm: "Finish with these",
    lookTitle: "Colour",
    lookNext: "Next",
    lookPrev: "Back",
    lookChoose: (name) => `Change the colour to ${name}`,
    looks: {
      paper: "Paper",
      linen: "Linen",
      lamp: "Lamp",
      pine: "Pine",
      album: "Album",
      flash: "Flash",
      ink: "Ink",
      walnut: "Walnut",
    },
  },
  consent: {
    title: "Can we show this photo\non the media wall?",
    lead: "It will take turns on the wall with other guests’ photos.\nYou still get your photo if you say no.",
    yes: "Yes, show it",
    no: "No, just for me",
    note: "Photos are deleted after a set period.\nIf you change your mind later, tell a volunteer and we’ll take it down right away.\nOur team may hide a photo that does not suit the screen.",
    publicNote: "The media wall is shown on the screen here and at its web address.",
    finished: "Your finished photo",
    making: "Making your photo",
  },
  delivery: {
    title: "Get your photo on your phone",
    lead: "Point your phone’s camera at the QR code.",
    onWall: "Look for your photo on the big screen in a little while.",
    reviewChecking: "We are checking your photo. One moment, please.",
    reviewDelayed:
      "The check is taking a little longer. We will show your photo once it has been checked.",
    done: "All done",
    resetSoon: "This screen will reset in a moment",
    qrNote: "Scan it with your phone\nto download the photo",
    session: (code) => `Session ${code}`,
    pendingTitle: "Getting your QR code ready",
    pendingLead:
      "Your photo is saved. The internet is a little slow, so the QR code is taking longer.\nWait a moment and it will appear here.",
    withoutQr: "Start over without the QR",
    authTitle: "Please call a helper",
    authLead: "This device needs to be registered. Your photo is kept safe on it.",
    queuedTitle: "Sending your photo",
    queuedLead:
      "Your photo is saved on this device.\nOnce we’re connected, we’ll send it and show the QR code.",
    retry: "Try again",
    failedTitle: "We couldn’t send your photo",
    temporaryQueue: "The photo is held temporarily. Keep this page open and tell a helper.",
    failedLead:
      "Please show this screen to a helper.\nThey’ll help you check how the sending went.",
    home: "Start over",
    sendingTitle: "Sending your photo",
    sendingLead: "Just a moment, please.",
  },
  mobile: {
    receivedTitle: "Your photo arrived",
    receivedLead:
      "Our team will check it, then hang it on the media wall.\nThis may take a little while.",
    home: "Start over",
    retry: "Try again",
    failed: {
      offline: {
        title: "We’re not connected to the internet right now",
        lead: "Sending your own photo needs the internet. You can still take photos here.",
      },
      paused: {
        title: "Photo submissions are paused right now",
        lead: "Please try again in a little while. You can still take photos here.",
      },
      error: { title: "We couldn’t make a QR code", lead: "Tap “Try again.”" },
    },
    title: "Scan the QR code with your phone",
    stepsLabel: "Steps",
    steps: [
      "Scan the QR code with your phone and choose a frame",
      "Pick as many photos as the frame holds, in the order they go in",
      "Choose whether to show it on the media wall, then save your photo",
    ],
    lan: "Your phone needs to be on the event Wi-Fi for this to open.",
    making: "Making the QR code…",
    waiting: "This screen changes\nwhen your photo arrives",
  },
  idle: {
    warning: (seconds) =>
      `Going back to the start in ${seconds} seconds. Tap the screen to keep going.`,
    stay: "Keep going",
  },
  home: {
    title: "Go back to the start?",
    lead: "The photos you’ve taken so far will be deleted and not saved.",
    stay: "Keep going",
    leave: "Start over",
  },
};

const zh: KioskCopy = {
  langName: "中文",
  langGroup: "언어 · Language",
  sound: "声音",
  ticket: {
    dayOrdinal: (n) => `今天第 ${n} 份记录`,
    dayRecord: "今天的记录",
  },
  attract: {
    start: "点击屏幕开始",
    event: "Christmas Village 2026",
  },
  welcome: {
    title: "一起留下圣诞的回忆",
    lead: "拍照后用手机领取，或者把你的照片发上来，一起挂到大屏幕上。",
    camera: "在这里拍照",
    cameraLead: "拍六张，挑选后用手机领取",
    mobile: "用我的照片参与",
    mobileLead: "把手机里的照片发送到媒体墙",
    paused: "目前暂时停止接收照片",
  },
  chrome: {
    back: "上一步",
    home: "回到开头",
  },
  steps: {
    of: (step, total) => `第 ${step} 步，共 ${total} 步`,
  },
  frame: {
    pickTitle: "选择一个相框",
    next: "下一步",
    shoot: "用这个相框拍照",
    slots: (n) => `${n} 张相框`,
  },
  /**
   * The phone page's frame step (app/m/[token], D103). These were the booth's words before
   * 「틀 선택 v2」; the phone flow keeps them unchanged.
   */
  phoneFrame: {
    pickTitle: "请选择你喜欢的相框",
    confirm: "就用这个相框",
    changeFrame: "更换相框",
  },
  name: {
    film3: "胶片 3格",
    film4: "胶片 4格",
    polaroid1: "拍立得 1格",
    polaroid3: "拍立得 3格",
    verse4: "圣经经文 4格",
    check2: "格纹 2格",
    lace1: "蕾丝 1格",
    film35: "35mm胶片 4格",
  },
  hint: {
    film3: "可选颜色·标志",
    film4: "可选米色·红色",
    check2: "可选红色·蓝色",
    film35: "彩色·黑白·复古棕",
  },
  option: {
    titleColorLogo: "请选择颜色和标志",
    titleColor: "请选择颜色",
    locked: (frame) => `${frame} · 拍摄后无法更改`,
    shoot: "就这样拍",
  },
  label: {
    color: "颜色",
    logo: "标志",
  },
  value: {
    mono: "黑白",
    sepia: "复古棕",
    logoOn: "显示",
    logoOff: "不显示",
    cream: "米色",
    red: "红色",
    blue: "蓝色",
    natural: "彩色",
  },
  camera: {
    startingTitle: "正在打开摄像头",
    startingLead: "如果弹出请求权限的窗口，请点“允许”。",
    preview: "正在准备预览……",
    retry: "再试一次",
    home: "回到开头",
    choose: "摄像头",
    defaultDevice: "默认摄像头",
    errors: {
      denied: {
        title: "摄像头未被允许使用",
        lead: "请在浏览器中允许使用摄像头后再试一次。\n如果还是不行，请告诉引导工作人员。",
      },
      missing: {
        title: "找不到摄像头",
        lead: "请检查摄像头是否连接好，然后再试一次。",
      },
      unsupported: {
        title: "这个屏幕无法使用摄像头",
        lead: "需要用 HTTPS 地址或受支持的浏览器打开。请告诉工作人员。",
      },
      failed: { title: "摄像头暂时停住了", lead: "请点“再试一次”。" },
    },
  },
  shoot: {
    shot: (n) => `第 ${n} 张照片`,
    flashOn: "开启屏幕补光",
    flashOff: "关闭屏幕补光",
    lead: "请看着镜头微笑。\n数字变成 0 就会拍下来。",
    free: "自由摆姿势",
    guide: "给我姿势建议",
    plan: (seconds, total) => `每隔 ${seconds} 秒拍一张，一共 ${total} 张`,
    video: "拍摄过程也会保存成一段无声短视频。",
    pose: "推荐姿势",
    progress: (done, total) => `已拍 ${done} 张，共 ${total} 张`,
  },
  review: {
    title: "拍得好看吗？",
    confirm: "就这样吧",
  },
  select: {
    title: (required, total) => `请从 ${total} 张中选 ${required} 张`,
    lead: (selected, required) => `会按你选择的顺序放进相框。已选 ${selected} / ${required} 张。`,
    choose: (n) => `选择第 ${n} 张照片`,
    unchoose: (n) => `取消选择第 ${n} 张照片`,
    confirm: "用这些照片完成",
    lookTitle: "色调",
    lookNext: "下一页",
    lookPrev: "上一页",
    lookChoose: (name) => `换成“${name}”色调`,
    looks: {
      paper: "相纸",
      linen: "亚麻",
      lamp: "灯光",
      pine: "松绿",
      album: "相册",
      flash: "闪光",
      ink: "墨黑",
      walnut: "胡桃",
    },
  },
  consent: {
    title: "可以把这张照片\n放到媒体墙上吗？",
    lead: "照片会和其他人的照片一起轮流显示在媒体墙上。\n选“不用”也一样可以领取照片。",
    yes: "好的，请放上去",
    no: "不用，只给我自己看",
    note: "照片会在规定期限后删除。\n放上去之后，只要告诉引导志愿者，我们会马上撤下。\n不适合在大屏幕上展示的照片，运营团队可能会隐藏。",
    publicNote: "媒体墙会同时显示在活动现场的屏幕和网络地址上。",
    finished: "完成的照片",
    making: "正在制作照片",
  },
  delivery: {
    title: "请用手机领取照片",
    lead: "请用手机摄像头扫描二维码。",
    onWall: "稍后请在大屏幕上找找你的照片。",
    reviewChecking: "正在确认照片，请稍等。",
    reviewDelayed: "照片确认需要多一点时间。确认无误后会显示在屏幕上。",
    done: "已经领取了",
    resetSoon: "稍后会回到开头画面",
    qrNote: "用手机扫描后\n就能下载照片文件",
    session: (code) => `编号 ${code}`,
    pendingTitle: "正在准备二维码",
    pendingLead:
      "照片已安全保存。网络有点慢，二维码来得比较晚。\n请稍等，二维码会出现在这个画面上。",
    withoutQr: "不要二维码，回到开头",
    authTitle: "请叫工作人员过来",
    authLead: "这台设备需要登记。照片已安全保存在这台设备上。",
    queuedTitle: "正在发送照片",
    queuedLead: "照片已保存在这台设备上。\n一连上网络，我们就会自动发送并显示二维码。",
    retry: "再试一次",
    failedTitle: "照片发送失败",
    temporaryQueue: "照片仅为临时保存。请保持页面开启并联系工作人员。",
    failedLead: "请把这个画面给引导工作人员看。\n我们会帮你确认发送状态。",
    home: "回到开头",
    sendingTitle: "正在发送照片",
    sendingLead: "请稍等一下。",
  },
  mobile: {
    receivedTitle: "照片已收到",
    receivedLead: "运营团队确认后，会把它挂到媒体墙上。\n确认可能需要一点时间。",
    home: "回到开头",
    retry: "再试一次",
    failed: {
      offline: {
        title: "目前没有连接到网络",
        lead: "发送自己的照片需要网络。现在仍然可以在这里拍照。",
      },
      paused: {
        title: "目前暂时停止接收照片",
        lead: "请稍后再试。现在仍然可以在这里拍照。",
      },
      error: { title: "无法生成二维码", lead: "请点“再试一次”。" },
    },
    title: "请用手机扫描二维码",
    stepsLabel: "步骤",
    steps: [
      "用手机扫描二维码，选择喜欢的相框",
      "按相框的格数，按放入的顺序选照片",
      "选择是否公开到媒体墙，然后保存做好的照片",
    ],
    lan: "手机需要连接活动现场的 Wi-Fi 才能打开。",
    making: "正在生成二维码……",
    waiting: "照片收到后\n这个画面会切换",
  },
  idle: {
    warning: (seconds) => `${seconds} 秒后会回到开头画面。要继续的话，请点一下屏幕。`,
    stay: "继续",
  },
  home: {
    title: "要回到开头画面吗？",
    lead: "目前拍的照片会被删除，不会保存。",
    stay: "继续拍",
    leave: "回到开头",
  },
};

export const KIOSK_COPY: Record<KioskLang, KioskCopy> = { ko, en, zh };

/** Text with "\n" line breaks, for the screens to render. */
export function lines(text: string): string[] {
  return text.split("\n");
}

/** A frame's or pose's name in the guest's language; Korean when a language has none. */
export function localizedLabel(
  item: { label: string; labelEn?: string; labelZh?: string },
  lang: KioskLang,
): string {
  if (lang === "en") return item.labelEn ?? item.label;
  if (lang === "zh") return item.labelZh ?? item.label;
  return item.label;
}
