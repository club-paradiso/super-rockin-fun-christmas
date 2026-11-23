# 색감 시장조사 (2026-11-23)

STUDIO SHALOM 부스의 색감 필터를 새로 설계하기 전에 한 조사다. 결론은 `config/looks/index.ts`의
룩 8종과 `docs/research/existing-filter-audit.md`로 이어진다.

## 0. 이 문서를 읽는 법

**조사 방법.** 조사 에이전트 3개가 검색한 뒤 페이지를 직접 열어 읽었다. 페이지 전체를 통독한 것이
아니라 관련 구절을 찾아 읽은 것이고, 이 문서를 쓴 쪽이 각 페이지를 다시 열어 대조하지는 않았다.
수치 커브를 준 출처는 하나도 없다. 룩의 숫자는 전부 우리가 정했다.

**표기.**

| 표기        | 뜻                                                                                                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 확인        | 연 페이지에 그렇게 적혀 있다                                                                                                                                                                 |
| 추정        | 확인된 내용 여러 개를 이어서 내린 판단                                                                                                                                                       |
| 확인 불가   | 페이지를 열지 못했거나, 검색 결과 요약만 봤거나, 자료가 없다                                                                                                                                 |
| 재확인 필요 | 내용은 읽었지만 여는 방식에 문제가 있었다. PetaPixel은 자동 접근을 막는데(다른 에이전트는 403), 한 에이전트가 브라우저 UA를 붙여 열었다. 사람이 직접 열어 확인하기 전에는 근거로 쓰지 않는다 |

**열지 못한 곳.** 포토이즘·인생네컷·포토매틱 공식 사이트(403), 모든 브랜드의 공식 인스타그램,
캐릿·대학내일·오픈서베이, Fujifilm·VSCO·Dehancer 공식 페이지, Ilford 공식 자료, Steve Yedlin의
글, Huji Cam·Dazz Cam 자료, Wikipedia. 이들에 기대는 내용은 전부 "확인 불가"다.

## 1. 국내 셀프 포토부스

운영 여부를 먼저 확인했고, 확인하지 못한 브랜드(모노맨션, 셀픽스)는 뺐다.

| 브랜드       | 운영 확인                                                   | 기본 색감                                                                                         | 필터 선택                                                                         | 흑백               | 보정                                                                 | 시즌·콜라보 틀의 색                                                            |
| ------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 하루필름     | 확인. 공식 "전국 99개 매장", 공지 2026-11-05 [K1]           | 확인(2023). 파란 배경지, 편집에서 차갑게 톤업해 더 하얗게 [K2]. "파스텔톤의 인테리어와 필터" [K3] | 확인 불가                                                                         | 확인 불가          | "예쁜 보정"이 강점으로 꼽힘(2022) [K4]. 정도는 수치 없음             | "계절과 테마에 맞춰 바뀌는 프레임" [K1]. 사진 색을 틀마다 바꾸는지는 확인 불가 |
| 포토이즘     | 확인. "전 세계 1,000개 이상"(2026-07) [K6], 계열 568곳 [K5] | 확인 불가. 계열 '컬러드'는 컬러 배경이 콘셉트 [K5]                                                | 확인 불가                                                                         | 확인 불가          | 확인. "AI 얼굴 보정 기능" 도입 [K6]                                  | 아티스트·시즌 테마 프레임 [K2], "에디션 배경지" [K6]                           |
| 인생네컷     | 확인. 2025년 273곳 [K5], 인생네컷+ 출점(2025-09) [K7]       | 확인 불가                                                                                         | 확인(2023). 퍼스널 컬러 필터, 일부 매장 LED 배경과 피부톤 기반 메이크업 필터 [K2] | 확인 불가          | 확인 불가                                                            | 색을 콘셉트 부스 단위로 바꾼다. 분홍 퍼 배경 등 [K7]                           |
| 포토시그니처 | 확인. 공식에 2026-11-01~2027-01-31 프레임 [K8]              | 확인 불가. "DSLR 카메라로 최상의 화질"만 표방 [K8]                                                | 확인. "AI필터 / 뷰티필터". 종류 수는 미기재 [K8]                                  | 확인 불가          | 뷰티필터 있음 [K8]                                                   | 매달 바뀌는 한정판 캐릭터 콜라보 [K8]                                          |
| 포토그레이   | 확인. 공식 사이트 운영 [K9], 2025 보도 [K10]                | 확인 불가(회색 배경·모노크롬이라는 통설은 연 페이지에서 못 찾음)                                  | 확인(2025). 하두리 부스에서 보정 옵션 선택, "옅은 노이즈, 특유의 쿨톤 필터" [K10] | 확인 불가          | 확인. "인위적이지않은 자연스러운 보정", 원본/시그니처 보정 비교 [K9] | 셀럽·캐릭터 콜라보 [K9][K10]                                                   |
| 돈룩업       | 2025년은 확인 [K10]. 2026년은 확인 불가                     | 확인 불가. 하이앵글이 정체성 [K10]                                                                | 확인 불가                                                                         | 확인 불가          | 확인 불가                                                            | 지드래곤 등 협업 [K10][K13]                                                    |
| 포토매틱     | 2026년 국내 운영은 확인 불가(공식 403)                      | 확인(2019). "흑백 사진이 기본", 리모컨 셀프 스튜디오 [K11]                                        | 확인 불가                                                                         | 기본값(2019) [K11] | 확인 불가                                                            | 전시·명소에 콜라보 부스를 따로 설치(2022) [K12]                                |

참고(확인, [K10]): 하루필름 운영사의 자매 브랜드 '크림필터'는 "크림톤 조명이 특징"이다. 한 회사가
차가운 톤(하루필름)과 따뜻한 톤(크림필터)을 브랜드로 나눠 운영한다.

**읽어 낼 것.** 큰 브랜드의 경쟁 축은 필터 개수가 아니라 얼굴 보정(뷰티·AI 필터)과 콘셉트·콜라보다.
"더 이상 사진 품질로 경쟁할 수 없는 상황"이고 차별점은 콘셉트와 공간이라는 전문가 진단이 있다(확인,
[K10]). 브랜드별 필터 개수와 흑백 지원 여부는 대부분 확인하지 못했다.

## 2. 2025–2026 국내 20~30대의 사진 색감

| 흐름                            | 표기      | 근거                                                                                                                                                 |
| ------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 디카(빈티지 콤팩트) 감성이 주류 | 확인      | "거친 화질과 빛바랜 듯한 색감이 매력", 디카 거래액 1~9월 +74%, 20대 이하 63% [K18]. "빈티지한 색감과 투박한 화질" [K15]                              |
| 플래시 직광                     | 확인      | "노란 기가 도는 필터, 과감한 플래시", "강한 직광 플래시, 차가운 색감" [K14]. 플래시로 "얼굴과 배경의 대비가 도드라지면서 2000년대 스냅" [K17]        |
| 색온도는 한 방향이 아니다       | 추정      | 노란 기·"따뜻하고 화사한 색감" [K14][K15], 구형 아이폰의 "어둡고 따뜻"한 색 [K23]이 많고, 차가운 플래시 룩이 변주로 함께 있다                        |
| 과보정·AI 보정 피로, 무보정     | 확인      | "획일화된 이미지보다 카메라 고유의 자연스러운 색감" [K20]. "무보정 사진, 필터 없는 게시물" [K21]                                                     |
| 필름으로 확장                   | 확인      | 필름카메라 호감 60.6%, 구매 의향 42.2%(2026-03 조사) [K19]                                                                                           |
| 빈티지 아날로그 포토부스        | 확인      | 화학 인화, "과한 보정 없이 흑백", "강렬한 대비의 빈티지 사진", "화려한 조명이나 매끄러운 보정 기능"이 없음 [K16]. **우리 콘셉트와 가장 가까운 근거** |
| 저채도                          | 추정      | 화장품에서는 확인(저채도 '멀멀', 필터가 "채도를 자연스럽게 낮춰") [K22]. 사진 톤으로 옮겨 읽은 것은 추정                                             |
| 쿨톤 보정이 주류인가            | 확인 불가 | 레트로 연출(하두리의 "쿨톤 필터" [K10])로만 확인된다                                                                                                 |

## 3. 필름 감성 앱·프리셋

| 시스템                   | 룩의 특징                                                                                                                           | 표기        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Fuji Classic Neg.        | 일반 모드보다 채도가 낮고 계조가 많다. 빨강이 주황 쪽으로 간다 [A12]                                                                | 확인        |
| Fuji Classic Chrome      | 낮은 채도와 두터운 톤, 하늘에서 마젠타가 빠진다. 단순한 채도 조절이 아니다 [A16]                                                    | 확인        |
| Fuji Reala Ace           | "피사체가 진할수록 색을 더 누른다"는 설명                                                                                           | 재확인 필요 |
| RNI All Films 5          | 프로파일 기반이라 대체로 은은하다. "film-like highlight compression". fade를 올리면 급격히 과해진다. 입술 채도가 빠질 수 있다 [A11] | 확인        |
| Dehancer                 | 할레이션·블룸·비네트·블랙 포인트를 따로 조절. Fuji 프로파일은 색 캐스트가 과하다는 평 [A25][A26]                                    | 확인        |
| VSCO Film 프리셋·Film X  | 스톡별 프리셋, 강한 변형일수록 "washed-out blacks or hue shifts"                                                                    | 재확인 필요 |
| Huji Cam, Dazz Cam       | 일회용 카메라풍, 빛샘, 주황 날짜 도장 등                                                                                            | 확인 불가   |
| Tezza, NOMO              | 자료 없음                                                                                                                           | 확인 불가   |
| Lightroom 필름 룩 가이드 | 하이라이트를 눌러 숄더를 만들고, 초록·노랑은 밝기를 낮추고 파랑은 시안 쪽으로, 그레인은 밝기 마스크로 [A5][A6][A7]                  | 확인        |

## 4. 실제 필름은 색을 어떻게 다루나

| 계열                                | 피부                                                                                                             | 초록·파랑                                                | 빨강                                               | 대비·하이라이트                                                  | 그레인                                   | 표기               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------- | ------------------ |
| 인물용 컬러 네거티브(Kodak 계열)    | "exceptionally smooth and natural skin tone", 어려운 조명에서도 자연스러운 피부 [F1][F2][F3]. 따뜻한 팔레트 [F4] | 제조사 언급 없음                                         | 빨강·주황이 강하다는 사용자 평 [F9]                | 중간 대비, 과노출에 강하다 [F4]. 혼합광에서도 색 재현 [F3]       | 고감도 중 가장 고운 편 [F2]              | 제조사 문구는 확인 |
| 차가운 쪽 네거티브(Fuji 계열, 단종) | 더 차갑다. "smooth and natural or devoid of all blood" [F8]                                                      | 초록·파랑이 깊다 [F8]                                    | 빨강·주황이 덜하다 [F8]                            | 낮은 대비·낮은 채도, 과노출하면 파스텔 [F7][F8]                  | 곱다 [F7]                                | 확인(리뷰)         |
| 소비자용 네거티브                   | 따뜻하고 자연스럽다 [F11][F12]                                                                                   | 한쪽은 초록이 노랗게, 다른 쪽은 차갑고 초록기 [F12][F13] | 따뜻한 쪽이 붉다 [F13]                             | 중간 대비 [F12]                                                  | 35mm에서는 보인다 [F12]                  | 확인               |
| 영화용 텅스텐 필름                  | 제조사 언급 없음                                                                                                 | 3200K 기준. 주광에서는 푸르다 [F15][F17]                 | 과노출 하이라이트 주변의 붉은 번짐(할레이션) [F17] | 18% 회색 위로 흰 카드 2⅓스톱 + 반사광 3½스톱 이상을 담는다 [F15] | 섀도 그레인이 적다 [F14]                 | 확인               |
| 흑백 필름                           | 초록·노랑 필터는 피부를 어둡게, 파랑은 피부 얼룩을 강조 [F24]                                                    | 노랑→주황→빨강 필터 순으로 하늘이 어두워진다 [F24]       | 오르토는 빨강을 어둡게 [F25]                       | 넓은 관용도 [F19]. "bold contrast… distinctive grain" [F23]      | 뚜렷한 쪽 [F19][F23], 아주 고운 쪽 [F20] | 확인               |

"빨강·주황 필터가 피부를 밝히고 잡티를 줄인다"는 통설은 연 페이지에서 문장을 찾지 못했다(확인 불가).
`Ink`의 채널 비중은 이 통설이 아니라 우리 샘플에서 본 결과로 정했다.

## 5. 저녁 실내와 크리스마스 조명

| 문제             | 조사 내용                                                                                                      | 필터에서 할 일                               | 표기 |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---- |
| 전구색의 주황기  | 자동 화이트밸런스는 따뜻함을 지우려 한다 [F29]. 3,000K 근처가 백열전구의 따뜻함을 살린다 [F27]                 | 다 지우지 않고 조금 남긴다                   | 추정 |
| 혼합광           | "먼저 피부에 맞춰 화이트밸런스를 잡고, 배경색의 세기는 HSL로 낮춘다" [F31]                                     | 피부 띠는 그대로 두고 배경 색만 누른다       | 확인 |
| 연색성 낮은 LED  | R9가 낮으면 피부가 창백하고 아파 보이며 후보정으로 복구할 수 없다 [F25b][F26]                                  | **필터로는 못 고친다.** 현장 조명이 답이다   | 확인 |
| 녹색·마젠타 틴트 | 색온도는 녹색–마젠타 축을 알려 주지 않는다 [F28]                                                               | 따뜻함/차가움과 별도로 틴트 축을 둔다        | 추정 |
| 빨강 채널 클리핑 | 한 채널만 넘치는 일이 흔하고(네온, 무대 조명, 따뜻한 조명 아래 피부), 색 디테일이 사라지고 색이 틀어진다 [F30] | 진한 빨강은 채도를 올리지 않고 밝기를 낮춘다 | 추정 |
| 섀도의 색 노이즈 | 색 노이즈는 노출이 부족한 섀도에 많다 [F32]                                                                    | 섀도를 들어 올리지 않고 섀도 채도를 낮춘다   | 추정 |

## 6. 피부 톤

| 규칙                                                                                               | 표기                                                                                      |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 인종·피부색과 무관하게 건강한 피부는 아주 좁은 색상 범위에 있다. 달라지는 것은 깊이와 채도다 [F38] | 확인                                                                                      |
| 한 점이 아니라 띠다("a spread, not a dot") [F38]. Adobe도 영역으로 표시한다 [F35]                  | 확인                                                                                      |
| 그 띠에서 벗어나면 아파 보인다는 구체적 서술(빨강 쪽은 취한 듯, 노랑 쪽은 창백)                    | 확인 불가(frame.io 글. 한 에이전트는 열었다고 했고 다른 에이전트에게는 사이트가 거부했다) |
| LUT 하나를 피부까지 일괄 적용하면 피부가 부자연스럽다. 컬러리스트는 피부를 따로 지킨다 [A10]       | 확인                                                                                      |
| 밝은 피부와 어두운 피부 모두 색상은 건드리지 않고 채도·밝기만 다르게 다룬다                        | 추정                                                                                      |

우리 쪽 실측: 아주 밝은 피부부터 아주 어두운 피부까지 12색이 OKLCh 색상 40°~70°, 채도
0.037~0.085에 모인다(`tests/unit/looks-engine.test.ts`). 위 규칙과 같은 방향이다.

## 7. 잘 되는 룩의 공통점

1. **밝은 곳이 잘리지 않고 눕는다.** 필름 특성곡선은 toe–직선–shoulder의 S자다 [A1][A2]. (확인)
2. **채도를 올리지 않는다. 누르고, 진한 색일수록 더 누른다.** [A16], 싸구려의 첫 표시가 전역 채도라는 지적 [A8]. (확인)
3. **색마다 다르게 움직인다.** 빨강은 주황 쪽 [A12], 초록·노랑은 어둡게, 파랑은 시안 쪽 [A6]. (확인)
4. **진한 색은 밝아지지 않고 짙어진다.** 필름은 염료가 빛을 빼는 방식이다 [A1]. 채도와 밝기를 묶은 것은 우리 해석이다. (추정)
5. **그레인은 고르지 않다.** 톤에 따라 달라지고 양 끝에서 줄어든다 [A5]. 어디서 가장 강한지는 출처가 엇갈린다: Kodak은 섀도와 노출 부족 영역 [A1], 다른 글은 미드톤~하이라이트 [A5]. 공통분모는 "균일 금지, 양 끝 감쇠"다. (확인, 피크 위치는 추정)
6. **세기를 조절할 수 있고 기본값이 절제돼 있다.** [A11] (확인)
7. **피부는 따로 지킨다.** [A10][F38] (확인)
8. **섀도는 색을 덜고, 들어 올리지 않는다.** [F32], 영화용 필름도 섀도 그레인이 적다 [F14]. (추정)

## 8. 싸구려 필터로 읽히는 것

1. **전역 채도 과다.** "Skin tones turn orange. Greens become radioactive" [A8]. (확인)
2. **정보가 사라진 검정, 또는 지나치게 띄운 섀도.** [A8], "washing out the image" [A33]. (확인)
3. **균일한 그레인.** 고르게 얹으면 "artificial" [A5]. (확인)
4. **프리셋·LUT 하나를 피부까지 일괄 적용.** [A10], 필름 프리셋이 색을 세게 밀어 거슬린다 [A11], 과한 색 캐스트 [A25]. (확인)
5. **선명도 헤일로, 과한 글로우, 강한 비네트.** [A9][A8][A7], 비네트는 과하면 "distracting" [A33]. (확인)

## 9. STUDIO SHALOM이 달라야 할 곳, 따라가야 할 곳

**비슷하면 안 되는 것**

- **얼굴 보정으로 겨루지 않는다.** 큰 브랜드는 뷰티·AI 필터로 간다 [K6][K8][K9]. 같은 시기에 과보정
  피로와 무보정 선호가 보도된다 [K20][K21]. 사진관은 얼굴을 고치지 않고 빛과 현상을 고른다.
- **차갑게 하얗게 띄우지 않는다.** 그건 이미 다른 브랜드의 자리다 [K2]. 우리 행사는 저녁 6~9시,
  전구 아래다. 전구의 따뜻함을 지우지 않는다.
- **필터를 많이 늘어놓지 않는다.** 룩은 틀이 정한다(`config/looks/frame-looks.json`). 손님이 고르는
  것은 틀 하나다.
- **룩끼리 따로 놀지 않는다.** 미디어월에 여러 사람의 스트립이 나란히 걸린다. 그래서 필름은 한
  종류(`HOUSE`)고 현상만 다르다.

**따라가야 하는 것**

- **빛바랜 색과 플래시.** 지금 20대가 좋아하는 방향이다 [K14][K17][K18]. `Album`과 `Flash`가 받는다.
- **흑백.** 빈티지 포토부스가 "과한 보정 없이 흑백"으로 주목받는다 [K16]. `Ink`가 받는다.
- **틀·시즌에 따라 색이 달라지는 것.** 브랜드들은 부스·배경 단위로 색을 바꾼다 [K7]. 우리는 틀마다
  룩을 짝짓는다.

**필터로 안 되는 것(범위 밖)**

- 연색성 낮은 LED 아래의 창백한 피부 [F25b]. 현장에 전구색·고연색 조명을 두는 것이 답이다.
- 어두운 사진을 밝히는 것, 사진마다 다른 화이트밸런스. LUT는 사진을 보고 판단하지 않는다.
- 넓게 날아간 조명의 가장자리 번짐. 할레이션은 전구·줄전구 같은 작은 광원에만 넣었다(과노출된 하이라이트 주변의 붉은 번짐 [F17]). 큰 밝은 면에는 일부러 뺐다: 종이 배경지가 날아가면 머리 둘레에 붉은 테가 생기기 때문이다.

## 10. 출처

확인 날짜는 전부 2026-11-23. 조사 에이전트가 연 페이지다(0절의 한계 참고).

**국내 브랜드·트렌드**

- K1 https://harufilm.com/ , https://harufilm.com/notices/18 — 하루필름 공식(2026)
- K2 https://www.koreajoongangdaily.com/korea/koreas-photo-booths-offer-creative-ways-of-leaving-memories/12031344 — Korea JoongAng Daily, 학생기자(2023)
- K3 https://maily.so/munhwa.cvs/posts/x1zg72yvzqg — 문화편의점 뉴스레터(2023)
- K4 https://gogumafarm.kr/인간의-욕심은-끝도-없고-포토부스는-발전한다 — 고구마팜(2022)
- K5 https://m.news.nate.com/view/20261115n02177 — 데일리안(2026-11)
- K6 https://m.seoul.co.kr/news/2026/07/06/20260706500032 — 서울신문(2026-07)
- K7 https://www.insight.co.kr/news/519572 — 인사이트(2025-09)
- K8 https://www.photosignature.co.kr/ , https://www.photosignature.co.kr/brand.php — 포토시그니처 공식
- K9 https://photogray.com/ , https://photogray.com/page.php?pgid=about , https://www.apr-in.com/en/apr_photogray.html — 포토그레이·에이피알 공식
- K10 https://www.hankyung.com/article/2025050921817 — 한국경제(2025-05)
- K11 https://www.insight.co.kr/news/238944 — 인사이트(2019)
- K12 https://gogumafarm.kr/포토부스-과몰입러의-포토부스-바이블 — 고구마팜(2022)
- K13 https://gogumafarm.kr/확-달라진-포토부스-총정리-z세대를-사로잡은-셀프-사/ — 고구마팜(2025-02)
- K14 https://www.esquirekorea.co.kr/article/1895102 — 에스콰이어(2026-01)
- K15 https://www.esquirekorea.co.kr/article/1907927 — 에스콰이어(2026-08)
- K16 https://www.esquirekorea.co.kr/article/1908956 — 에스콰이어(2026-09)
- K17 https://www.allurekorea.com/2026/10/28/요즘-셀럽들이-스마트-폰-대신-낭만적인-디카에-매료 — 얼루어(2026-10)
- K18 https://www.hankyung.com/article/2026100816921 — 한국경제(2026-10)
- K19 https://www.hankyung.com/article/202608288746H — 한국경제(2026-08)
- K20 https://www.insight.co.kr/news/558525 , https://www.hankyung.com/article/202606155859i — 인사이트·한국경제(2026-06)
- K21 https://www.hankyung.com/article/202602122476i — 한국경제(2026-02)
- K22 https://www.hankyung.com/article/202606184714i — 한국경제(2026-06)
- K23 https://www.hankyung.com/article/202503067290g — 한국경제(2025-03)

**필름·조명·피부**

- F1 https://www.kodakprofessional.com/sites/default/files/2025-07/e4051.pdf — Kodak 데이터시트 E-4051(2025)
- F2 https://www.kodakprofessional.com/sites/default/files/2025-07/e4050.pdf — Kodak 데이터시트 E-4050(2025)
- F3 https://www.kodakprofessional.com/sites/default/files/2025-07/e4040.pdf — Kodak 데이터시트 E-4040(2025)
- F4 https://thedarkroom.com/film/portra-400/ — The Darkroom(2019, 수정 2026)
- F7 https://thedarkroom.com/film/pro400h/ — The Darkroom(2019/2020)
- F8 https://casualphotophile.com/2018/11/28/fujifilm-fujicolor-pro-400h-film-profile/ — Casual Photophile(2018)
- F9 https://fstoppers.com/film/archenemies-kodak-portra-400-versus-fuji-pro-400h-507223 — Fstoppers(댓글 의견)
- F11 https://www.kodakprofessional.com/sites/default/files/wysiwyg/KodakUltraMax400TechSheet-1.pdf — Kodak E-7023(2016)
- F12 https://thedarkroom.com/film/gold-200/ — The Darkroom(2019, 수정 2025)
- F13 https://thedarkroom.com/kodak-utramax-400-vs-fujifilm-superia-x-tra-400-comparision/ — The Darkroom(2021)
- F14 https://www.kodak.com/en/motion/product/camera-films/500t-5219-7219/ — Kodak 제품 페이지
- F15 https://www.kodak.com/content/products-brochures/motion-picture/KODAK-VISION3-500T-5219-7219-brochure.pdf — Kodak 브로슈어(©2025)
- F17 https://cinestillfilm.com/blogs/news/cinestill-film-stock-primer — CineStill
- F19 https://kodakprofessional.com/sites/default/files/wysiwyg/film/f4017_trix_320400.pdf — Kodak F-4017(2021)
- F20 https://www.kodakprofessional.com/sites/default/files/wysiwyg/pro/resources/f4043_TMax_400.pdf — Kodak F-4043(2016)
- F23 https://thedarkroom.com/film/tri-x-400/ — The Darkroom(2019, 수정 2025)
- F24 https://emulsive.org/articles/guides/using-filters-with-monochrome-film — Emulsive(2021)
- F25 https://www.35mmc.com/02/05/2023/spectral-sensitivity-of-bw-film-a-deep-dive-into-orthochromatic-panchromatic-and-all-the-rest/ — 35mmc(2023)
- F25b https://www.waveformlighting.com/film-photography/why-cri-r9-is-so-important-for-skin-tones-a-spectral-analysis — Waveform Lighting(2018, 수정 2024)
- F26 https://www.waveformlighting.com/tech/what-is-cri-r9-and-why-is-it-important — Waveform Lighting(2018)
- F27 https://fstoppers.com/education/capturing-magic-guide-photographing-christmas-lights-new-photographers-687655 — Fstoppers(2024)
- F28 https://www.waveformlighting.com/film-photography/the-shortcomings-of-using-color-temperature-in-film-photography-lighting — Waveform Lighting(2018)
- F29 https://digital-photography-school.com/14-tips-for-great-candlelight-photography/ — Digital Photography School(2012)
- F30 https://fstoppers.com/education/what-clipping-and-how-spot-it-it-ruins-shot-903275 — Fstoppers(2026)
- F31 https://fstoppers.com/lightroom/3-ways-fix-mixed-lighting-your-photos-574506 — Fstoppers(2021)
- F32 https://digital-photography-school.com/how-to-avoid-and-reduce-noise-in-your-images/ — Digital Photography School(2024)
- F35 https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/analyze-color-tones-using-vectorscope.html — Adobe 도움말
- F38 https://fstoppers.com/photoshop/vectorscope-trick-perfect-skin-tones-camera-raw-904641 — Fstoppers(2026)

**앱·프리셋·필름 룩 만들기**

- A1 https://www.kodak.com/content/products-brochures/Film/kodak-essential-reference-guide-for-filmmakers.pdf — Kodak Essential Reference Guide for Filmmakers(연도 미확인)
- A2 https://www.kodak.com/content/products-brochures/Film/Basic-Photographic-Sensitometry-Workbook.pdf — Kodak H-740(2006)
- A5 https://fstoppers.com/lightroom/how-make-digital-photos-look-film-lightroom-691210 — Fstoppers(2025)
- A6 https://fstoppers.com/education/how-make-digital-photos-look-film-lightroom-902358 — Fstoppers(2026)
- A7 https://fstoppers.com/education/how-make-digital-look-film-without-killing-detail-722740 — Fstoppers(2026)
- A8 https://fstoppers.com/lightroom/10-lightroom-mistakes-are-ruining-your-photos-900338 — Fstoppers(2026)
- A9 https://fstoppers.com/post-production/5-reasons-your-photos-look-fake-and-how-fix-them-720150 — Fstoppers(2026)
- A10 https://fstoppers.com/originals/why-using-blockbuster-luts-doesnt-make-your-footage-look-exactly-theatrical-381625 — Fstoppers(2019)
- A11 https://fstoppers.com/lightroom/fstoppers-reviews-rnis-all-films-5-preset-pack-adobe-lightroom-and-acr-473152 — Fstoppers(2020)
- A12 https://fstoppers.com/gear/reala-ace-how-does-x100vis-new-film-simulation-compare-662962 — Fstoppers(2024)
- A16 https://digital-photography-school.com/fujifilm-jpg-film-simulations-guide/ — Digital Photography School(2020)
- A25 https://fstoppers.com/reviews/it-time-ditch-fuji-film-simulations-review-dehancer-film-emulator-603654 — Fstoppers(2022)
- A26 https://fstoppers.com/reviews/dehancer-film-emulation-review-bringing-magic-film-your-digital-photography-673374 — Fstoppers(2024)
- A33 https://fstoppers.com/landscapes/common-photo-editing-mistakes-and-how-avoid-them-683589 — Fstoppers(2024)

**재확인 필요(근거로 쓰지 않음).** PetaPixel 기사들: 필름 그레인 흉내 내기(2025-09, 2022-11), Reala
Ace(2024-06), VSCO 프리셋(2026-02, 2021-10, 2016-12), ACR Glow(2026-09), Arri Film Lab(2025-11), 2025년
필름 사진이 더 푸르고 덜 진해졌다는 집계(2025-09). 사람이 직접 열어 확인하면 3절·7절을 보강할 수 있다.
