workspace "Advanced Repayment Example" "Arquitectura C4 para la simulación de prepago de un crédito existente." {

    model {
        properties {
            "structurizr.groupSeparator" "/"
        }

        !impliedRelationships false

        // Alcance modelado (criterio 6): el softwareSystem raíz representa la
        // integración. Los Business Domains y Service Domains viven dentro de
        // su límite `Integration` (criterio 5).
        int010SimularPrepago = softwareSystem "Advanced Repayment Example" "Integración que simula el prepago de un crédito existente exponiendo el contrato del Service Domain Loan y orquestando las capacidades del nuevo core." {
            tags "Future,Integration,Locations,Azure"
            properties {
                "integration.id" "DEMO"
                "bian.businessScenario" "Advanced Repayment"
                "bian.businessScenario.type" "Native"
                "owner" "Integración Temenos"
                "cmdb" "Pending (TO-BE)"
                "location" "Cloud - Azure"
                "security" "OAuth2 (Azure Entra ID) · subscription keys en Vault"
            }

            group "Integration" {

                group "Business Domain - Loans and Deposit" {

                    group "Service Domain - Loan" {

                        group "Business (SD)" {
                            apiSdLoan = container "api-sd-loan" "Expone las operaciones BIAN de Loan requeridas por la simulación de prepago." "Azure API Management · REST" {
                                tags "Future,API,Technology,Security"
                                properties {
                                    "bian.businessDomain" "Loans and Deposit"
                                    "bian.sd" "Loan"
                                    "owner" "Integración Temenos"
                                    "cmdb" "Pending (TO-BE)"
                                    "security" "OAuth2 (Azure Entra ID) · subscription keys en Vault"
                                }

                                createAdvancedRepaymentEndpoint = component "POST /api/sd/loan/v1/advanced-repayment-simulation" "Inicia la simulación de prepago de un crédito existente." "REST · BIAN v13" {
                                    tags "Future,API,BIAN,Security"
                                    properties {
                                        "bian.sd" "Loan"
                                        "bian.op" "POST B154/BIAN/Loan/13.0.0/Loan/Initiate"
                                        "owner" "Integración Temenos"
                                        "security" "OAuth2 (Azure Entra ID) · subscription keys en Vault"
                                    }
                                }

                                retrieveRepaymentScheduleEndpoint = component "GET /api/sd/loan/v1/advanced-repayment-simulation/{simulationid}/schedules" "Recupera el cronograma resultante de la simulación de prepago." "REST · BIAN v13" {
                                    tags "Future,API,BIAN,Security"
                                    properties {
                                        "bian.sd" "Loan"
                                        "bian.op" "GET B154/BIAN/Loan/13.0.0/Loan/{simulationid}/Retrieve"
                                        "owner" "Integración Temenos"
                                        "security" "OAuth2 (Azure Entra ID) · subscription keys en Vault"
                                    }
                                }
                            }

                            micSdLoan = container "mic-sd-loan" "Implementa las operaciones del Service Domain Loan para la simulación de prepago." "AKS · Quarkus" {
                                tags "Future,Microservice,Technology,Security"
                                properties {
                                    "bian.sd" "Loan"
                                    "owner" "Integración Temenos"
                                    "cmdb" "Pending (TO-BE)"
                                    "security" "OAuth2 (Azure Entra ID) · subscription keys en Vault"
                                }
                            }

                            sdAdvancedRepaymentCreatedV1 = container "sd.advanced-repayment.created.v1" "Contiene los datos completos de las simulaciones de prepago ejecutadas satisfactoriamente." "Azure Event Hubs · Topic" {
                                tags "Future,Store,Technology,Security"
                                properties {
                                    "bian.sd" "Loan"
                                    "owner" "Integración Temenos"
                                    "cmdb" "Pending (TO-BE)"
                                    "data.model" "JSON Schema · contrato pendiente de definición"
                                    "security" "Acceso controlado por Azure Entra ID"
                                }
                            }

                            sdAdvancedRepaymentCreatedDeadLetterV1 = container "sd.advanced-repayment.created.dead-letter.v1" "Contiene los parámetros de entrada completos de las simulaciones de prepago que no pudieron procesarse." "Azure Event Hubs · Topic" {
                                tags "Future,Store,Technology,Security"
                                properties {
                                    "bian.sd" "Loan"
                                    "owner" "Integración Temenos"
                                    "cmdb" "Pending (TO-BE)"
                                    "data.model" "JSON Schema · contrato pendiente de definición"
                                    "security" "Acceso controlado por Azure Entra ID"
                                }
                            }
                        }

                        group "System (SYS)" {
                            apiSysIntCoreAdvancedRepayment = container "api-sys-int-core-advanced-repayment" "Expone las operaciones internas para crear una simulación de prepago y consultar su cronograma en el core." "Azure API Management · REST" {
                                tags "Future,API,Technology,Security,Custom Banking"
                                properties {
                                    "framework" "Custom Banking"
                                    "owner" "Integración Temenos"
                                    "cmdb" "Pending (TO-BE)"
                                    "security" "OAuth2 (Azure Entra ID) · subscription keys en Vault"
                                }

                                createAdvancedRepaymentSimulationEndpoint = component "POST /api/sys/int/core/advanced-repayment/v1/advanced-repayment" "Solicita la creación de una simulación de prepago de un crédito existente en el nuevo core." "REST" {
                                    tags "Future,API,Security,Custom Banking"
                                    properties {
                                        "framework" "Custom Banking"
                                        "owner" "Integración Temenos"
                                        "security" "OAuth2 (Azure Entra ID) · subscription keys en Vault"
                                    }
                                }

                                retrieveLoanSchedulesEndpoint = component "GET /api/sys/int/core/advanced-repayment/v1/advanced-repayment/{simulationid}/schedules" "Consulta el cronograma asociado a una simulación de prepago." "REST" {
                                    tags "Future,API,Security,Custom Banking"
                                    properties {
                                        "framework" "Custom Banking"
                                        "owner" "Integración Temenos"
                                        "security" "OAuth2 (Azure Entra ID) · subscription keys en Vault"
                                    }
                                }
                            }

                            micSysIntCoreAdvancedRepayment = container "mic-sys-int-core-advanced-repayment" "Adapta las operaciones de simulación de prepago y cronograma al contrato del nuevo core." "AKS · Quarkus" {
                                tags "Future,Microservice,Technology,Security,Custom Banking"
                                properties {
                                    "framework" "Custom Banking"
                                    "owner" "Integración Temenos"
                                    "cmdb" "Pending (TO-BE)"
                                    "security" "OAuth2 (Azure Entra ID) · subscription keys en Vault"
                                }
                            }

                            fncSysIntCoreReplicateAdvancedRepaymentStatus = container "fnc-sys-int-core-replicate-advanced-repayment-status" "Replica hacia Integración los cambios de estado de simulaciones de prepago publicados por Transact." "Azure Functions" {
                                tags "Future,Function,Technology,Security,Custom Banking"
                                properties {
                                    "framework" "Custom Banking"
                                    "owner" "Integración Temenos"
                                    "cmdb" "Pending (TO-BE)"
                                    "security" "OAuth2 (Azure Entra ID) · subscription keys en Vault"
                                }
                            }

                            sysAdvancedRepaymentStatusChangedV1 = container "sys.advanced-repayment.status-changed.v1" "Réplica los estados de las simulaciones de prepago solicitadas a Transact." "Azure Event Hubs · Topic" {
                                tags "Future,Store,Technology,Security,Custom Banking"
                                properties {
                                    "framework" "Custom Banking"
                                    "owner" "Integración Temenos"
                                    "cmdb" "Pending (TO-BE)"
                                    "data.model" "JSON Schema · contrato pendiente de definición"
                                    "security" "Acceso controlado por Azure Entra ID"
                                }
                            }
                        }
                    }
                }

                // API SYS transversal sin Business Domain (criterio 4).
                group "System (SYS)" {
                    apiSysUtilCoreRetrieveParameterization = container "api-sys-util-core-retrieve-parameterization" "Expone parámetros dinámicos a los microservicios SD y SYS de Integración." "Azure API Management · REST" {
                        tags "Future,API,Technology,Security,Custom Banking,Shared Platform Service"
                        properties {
                            "framework" "Custom Banking"
                            "owner" "Integración Temenos"
                            "cmdb" "Pending (TO-BE)"
                            "security" "OAuth2 (Azure Entra ID) · subscription keys en Vault"
                        }
                    }
                }
            }
        }

        // Canales, Experiencia y Proceso se representan como un único consumidor
        // legado porque su diseño deberá adaptarse al contrato del Service Domain.
        channels = softwareSystem "Legacy Channels" "Canales y satélites legados que acceden a la simulación de prepago mediante las capas de Experiencia y Proceso, fuera del alcance de este diseño." {
            tags "Live,External,Legacy,Locations,Azure"
            properties {
                "location" "Cloud - Azure"
            }
        }

        transactSystem = softwareSystem "Temenos Transact" "Nuevo core bancario al que está migrando la organización y que ejecuta la simulación de prepago de un crédito existente." {
            tags "Future,External,Core,Locations,Azure"
            properties {
                "owner" "Temenos"
                "cmdb" "Pending (TO-BE)"
                "location" "Cloud - Azure"
                "security" "OAuth2 · usuario y contraseña para APIs; Azure Entra ID para tópicos"
            }

            apiTransact = container "api-transact" "Expone las operaciones de Transact para crear simulaciones de prepago y consultar sus cronogramas." "Azure API Management (Temenos) · REST" {
                tags "Future,API,Technology,Security"
                properties {
                    "owner" "Temenos"
                    "cmdb" "Pending (TO-BE, en implementación)"
                    "security" "OAuth2 · usuario y contraseña"
                    "location" "Cloud - Azure"
                }

                advancedRepaymentCaptureComponent = component "AA.API.ADVANCED-REPAYMENT" "Recibe y adapta la solicitud para crear una simulación de prepago de un crédito existente en Transact." "REST" {
                    tags "Future,API,Security"
                    properties {
                        "owner" "Temenos"
                        "domain" "holdings"
                        "operation" "createLoanAdvanceRepaymentSimulation"
                        "endpoint" "POST /holdings/loans/advanced-repayment-simulations"
                        "security" "OAuth2 · usuario y contraseña"
                    }
                }

                schedulesApiComponent = component "AA.API.SCHEDULES.SIM" "Expone la consulta del cronograma completo de una simulación de prepago." "REST" {
                    tags "Future,API,Security"
                    properties {
                        "owner" "Temenos"
                        "domain" "holdings"
                        "operation" "getSchedulesSim"
                        "endpoint" "GET /holdings/arrangements/advanced-repayment-simulations/{simulationId}/schedules?arrangementId={Arrangement ID}"
                        "security" "OAuth2 · usuario y contraseña"
                    }
                }
            }

            transactCore = container "Transact Core" "Ejecuta la creación de simulaciones de prepago y la consulta de sus cronogramas completos." "Temenos Transact" {
                tags "Future,Core,Technology,Security"
                properties {
                    "owner" "Temenos"
                    "cmdb" "Pending (TO-BE, en implementación)"
                    "domain" "holdings"
                    "operations" "createLoanAdvanceRepaymentSimulation | getSchedulesSim"
                    "security" "Acceso restringido mediante api-transact"
                    "location" "Cloud - Azure"
                }
            }

            transactAdvancedRepaymentStatusChangedV1 = container "transact.advanced-repayment.status-changed.v1" "Publica los estados de ejecución de las simulaciones de prepago solicitadas a Transact." "Azure Event Hubs · Topic" {
                tags "Future,Store,Technology,Security"
                properties {
                    "owner" "Temenos"
                    "cmdb" "Pending (TO-BE, en implementación)"
                    "data.model" "JSON Schema · contrato pendiente de definición"
                    "security" "Acceso controlado por Azure Entra ID"
                    "location" "Cloud - Azure"
                }
            }
        }

        // Relaciones L1 del contexto (sin asignaciones nombradas: las propiedades
        // viven en las relaciones anónimas para evitar duplicidad).
        channels -> int010SimularPrepago "invoke:sync" "HTTPS/JSON" {
            properties {
                "endpoints" "POST /api/sd/loan/v1/advanced-repayment-simulation | GET /api/sd/loan/v1/advanced-repayment-simulation/{simulationid}/schedules"
            }
        }
        int010SimularPrepago -> transactSystem "invoke:sync" "HTTPS/JSON" {
            properties {
                "endpoints" "POST /holdings/loans/advanced-repayment-simulations | GET /holdings/arrangements/advanced-repayment-simulations/{simulationId}/schedules?arrangementId={Arrangement ID}"
            }
        }

        // Respuestas del business scenario; se excluyen de las vistas estáticas.
        transactSystem -> int010SimularPrepago "invoke:sync" "HTTPS/JSON" {
            tags "Response"
            properties {
                "endpoints" "POST /holdings/loans/advanced-repayment-simulations | GET /holdings/arrangements/advanced-repayment-simulations/{simulationId}/schedules?arrangementId={Arrangement ID}"
            }
        }
        int010SimularPrepago -> channels "invoke:sync" "HTTPS/JSON" {
            tags "Response"
            properties {
                "endpoints" "POST /api/sd/loan/v1/advanced-repayment-simulation | GET /api/sd/loan/v1/advanced-repayment-simulation/{simulationid}/schedules"
            }
        }

        // Relaciones L2: el detalle del endpoint se expresa en los steps de los flujos.
        channels -> apiSdLoan "invoke:sync" "HTTPS/JSON"
        apiSdLoan -> micSdLoan "invoke:sync" "HTTPS/JSON" {
            properties {
                "endpoints" "POST .../loan/v1/advanced-repayment-simulation | GET .../advanced-repayment-simulation/{simulationid}/schedules"
            }
        }
        micSdLoan -> apiSysUtilCoreRetrieveParameterization "invoke:sync" "HTTPS/JSON" {
            properties {
                "api" "api-sys-util-core-retrieve-parameterization"
                "endpoint" "Pending"
            }
        }
        micSdLoan -> apiSysIntCoreAdvancedRepayment "invoke:sync" "HTTPS/JSON" {
            properties {
                "endpoints" "POST /api/sys/int/core/advanced-repayment/v1/advanced-repayment | GET /api/sys/int/core/advanced-repayment/v1/advanced-repayment/{simulationid}/schedules"
            }
        }
        apiSysIntCoreAdvancedRepayment -> micSysIntCoreAdvancedRepayment "invoke:sync" "HTTPS/JSON" {
            properties {
                "endpoints" "POST .../advanced-repayment | GET .../{simulationid}/schedules"
            }
        }
        micSysIntCoreAdvancedRepayment -> apiTransact "invoke:sync" "HTTPS/JSON" {
            properties {
                "endpoints" "POST /holdings/loans/advanced-repayment-simulations | GET /holdings/arrangements/advanced-repayment-simulations/{simulationId}/schedules?arrangementId={Arrangement ID}"
            }
        }

        // Relaciones L2 de Transact. El alcance modelado aparece agregado como
        // sistema externo en las vistas cuyo ámbito es Temenos Transact.
        apiTransact -> transactCore "invoke:sync" "HTTPS/JSON"
        transactCore -> apiTransact "invoke:sync" "HTTPS/JSON" {
            tags "Response"
        }
        apiTransact -> int010SimularPrepago "invoke:sync" "HTTPS/JSON" {
            tags "Response"
        }
        transactCore -> transactAdvancedRepaymentStatusChangedV1 "put message" "AMQP/TCP" {
            tags "Async"
            properties {
                "topic" "transact.advanced-repayment.status-changed.v1"
            }
        }
        int010SimularPrepago -> transactAdvancedRepaymentStatusChangedV1 "subscribe to" "AMQP/TCP" {
            tags "Async"
            properties {
                "topic" "transact.advanced-repayment.status-changed.v1"
            }
        }

        // Relaciones L3 de los contratos publicados en Azure API Management.
        channels -> createAdvancedRepaymentEndpoint "invoke:sync" "HTTPS/JSON"
        createAdvancedRepaymentEndpoint -> micSdLoan "invoke:sync" "HTTPS/JSON"
        channels -> retrieveRepaymentScheduleEndpoint "invoke:sync" "HTTPS/JSON"
        retrieveRepaymentScheduleEndpoint -> micSdLoan "invoke:sync" "HTTPS/JSON"
        micSdLoan -> createAdvancedRepaymentSimulationEndpoint "invoke:sync" "HTTPS/JSON"
        createAdvancedRepaymentSimulationEndpoint -> micSysIntCoreAdvancedRepayment "invoke:sync" "HTTPS/JSON"
        micSdLoan -> retrieveLoanSchedulesEndpoint "invoke:sync" "HTTPS/JSON"
        retrieveLoanSchedulesEndpoint -> micSysIntCoreAdvancedRepayment "invoke:sync" "HTTPS/JSON"

        // Relaciones L3 hacia los componentes de api-transact.
        micSysIntCoreAdvancedRepayment -> advancedRepaymentCaptureComponent "invoke:sync" "HTTPS/JSON" {
            properties {
                "endpoint" "POST /holdings/loans/advanced-repayment-simulations"
            }
        }
        advancedRepaymentCaptureComponent -> transactCore "invoke:sync" "HTTPS/JSON"
        transactCore -> advancedRepaymentCaptureComponent "invoke:sync" "HTTPS/JSON" {
            tags "Response"
        }
        advancedRepaymentCaptureComponent -> micSysIntCoreAdvancedRepayment "invoke:sync" "HTTPS/JSON" {
            tags "Response"
        }
        micSysIntCoreAdvancedRepayment -> schedulesApiComponent "invoke:sync" "HTTPS/JSON" {
            properties {
                "endpoint" "GET /holdings/arrangements/advanced-repayment-simulations/{simulationId}/schedules?arrangementId={Arrangement ID}"
            }
        }
        schedulesApiComponent -> transactCore "invoke:sync" "HTTPS/JSON"
        transactCore -> schedulesApiComponent "invoke:sync" "HTTPS/JSON" {
            tags "Response"
        }
        schedulesApiComponent -> micSysIntCoreAdvancedRepayment "invoke:sync" "HTTPS/JSON" {
            tags "Response"
        }

        micSdLoan -> sdAdvancedRepaymentCreatedV1 "put message" "AMQP/TCP" {
            tags "Async"
            properties {
                "topic" "sd.advanced-repayment.created.v1"
            }
        }
        micSdLoan -> sdAdvancedRepaymentCreatedDeadLetterV1 "put message" "AMQP/TCP" {
            tags "Async,Error"
            properties {
                "topic" "sd.advanced-repayment.created.dead-letter.v1"
            }
        }
        transactSystem -> fncSysIntCoreReplicateAdvancedRepaymentStatus "publish event" "AMQP/TCP" {
            tags "Async"
            properties {
                "topic" "transact.advanced-repayment.status-changed.v1"
            }
        }
        fncSysIntCoreReplicateAdvancedRepaymentStatus -> transactAdvancedRepaymentStatusChangedV1 "subscribe to" "AMQP/TCP" {
            tags "Async"
            properties {
                "topic" "transact.advanced-repayment.status-changed.v1"
            }
        }
        fncSysIntCoreReplicateAdvancedRepaymentStatus -> sysAdvancedRepaymentStatusChangedV1 "put message" "AMQP/TCP" {
            tags "Async"
            properties {
                "topic" "sys.advanced-repayment.status-changed.v1"
            }
        }
        // Subscripción + entrega consolidada en una relación con tag EventDelivery.
        micSysIntCoreAdvancedRepayment -> sysAdvancedRepaymentStatusChangedV1 "subscribe to" "AMQP/TCP" {
            tags "Async,EventDelivery"
            properties {
                "topic" "sys.advanced-repayment.status-changed.v1"
            }
        }

        // Respuestas síncronas del L2.
        transactSystem -> micSysIntCoreAdvancedRepayment "invoke:sync" "HTTPS/JSON" {
            tags "Response"
        }
        micSysIntCoreAdvancedRepayment -> apiSysIntCoreAdvancedRepayment "invoke:sync" "HTTPS/JSON" {
            tags "Response"
        }
        apiSysIntCoreAdvancedRepayment -> micSdLoan "invoke:sync" "HTTPS/JSON" {
            tags "Response"
        }
        micSdLoan -> apiSdLoan "invoke:sync" "HTTPS/JSON" {
            tags "Response"
        }
        apiSdLoan -> channels "invoke:sync" "HTTPS/JSON" {
            tags "Response"
        }
    }

    views {
        // ============================================================
        // Bloque 1 — Vistas estructurales (L1, L2, L3)
        // ============================================================

        systemContext int010SimularPrepago "S_L1_DEMO_Integration" "S: L1 / DEMO - Integration. Audiencia: negocio, arquitectura y responsables de canales. Propósito: mostrar el alcance modelado, los actores externos y la colaboración de negocio de alto nivel." {
            title "S: L1 / DEMO - Integration"
            include *
            exclude "relationship.tag==Response"
            autoLayout lr
            default
        }

        container int010SimularPrepago "S_L2_Loan_SimularPrepago" "S: L2 / Loan - Simular Prepago. Audiencia: arquitectura y equipos de implementación. Propósito: mostrar las apps, stores y dependencias que aceptan una simulación de prepago." {
            title "S: L2 / Loan - Simular Prepago"
            include *
            exclude "relationship.tag==Response"
            exclude "relationship.tag==EventDelivery"
            autoLayout lr 300 220
        }

        container int010SimularPrepago "S_L2_Loan_Overview" "S: L2 / Loan - Overview. Audiencia: arquitectura y equipo Integración Temenos. Propósito: mostrar la estructura interna completa de la integración y sus dependencias." {
            title "S: L2 / Loan - Overview"
            include *
            exclude "relationship.tag==EventDelivery"
            autoLayout lr 300 220
        }

        container transactSystem "S_L2_Transact_SimularPrepago" "S: L2 / Transact - Simular Prepago. Audiencia: arquitectura, Integración Temenos y Temenos. Propósito: mostrar las APIs, el core y el tópico de estados de Transact." {
            title "S: L2 / Transact - Simular Prepago"
            include *
            exclude "relationship.tag==Response"
            autoLayout lr 300 220
        }

        component apiSdLoan "S_L3_api-sd-loan_Endpoints" "S: L3 / api-sd-loan - Endpoints. Audiencia: arquitectura y equipos de implementación. Propósito: mostrar las operaciones públicas y sus implementaciones." {
            title "S: L3 / api-sd-loan - Endpoints"
            include *
            autoLayout lr
        }

        component apiSysIntCoreAdvancedRepayment "S_L3_api-sys-int-core-advanced-repayment_Endpoints" "S: L3 / api-sys-int-core-advanced-repayment - Endpoints. Audiencia: arquitectura y equipos de implementación. Propósito: mostrar las operaciones de adaptación al nuevo core." {
            title "S: L3 / api-sys-int-core-advanced-repayment - Endpoints"
            include *
            autoLayout lr
        }

        component apiTransact "S_L3_api-transact_Components" "S: L3 / api-transact - Components. Audiencia: arquitectura, Integración Temenos y Temenos. Propósito: mostrar los componentes que crean simulaciones de prepago y consultan cronogramas." {
            title "S: L3 / api-transact - Components"
            include *
            exclude "relationship.tag==Response"
            autoLayout lr
        }

        // ============================================================
        // Bloque 2 — Vistas dinámicas, de comportamiento o flujo
        // ============================================================

        dynamic * "D_DEMO-LoanBusinessScenario" "D: DEMO - Loan Business Scenario. Audiencia: negocio y arquitectura. Propósito: mostrar la colaboración requerida para simular el prepago de un crédito." {
            title "D: DEMO - Loan Business Scenario"
            1: channels -> int010SimularPrepago "Request simulation"
            2: int010SimularPrepago -> transactSystem "Calculate simulation"
            3: transactSystem -> int010SimularPrepago "Return simulation"
            4: int010SimularPrepago -> channels "Provide simulation"
            autoLayout lr
        }

        // Flujos principales — extremo a extremo.
        dynamic int010SimularPrepago "D_DEMO-CreateAdvancedRepaymentSimulation" "D: DEMO - Create Advanced Repayment Simulation. Audiencia: arquitectura y equipos de implementación. Propósito: aceptación inicial de una simulación de prepago de un crédito existente." {
            title "D: DEMO - Create Advanced Repayment Simulation"
            1: channels -> apiSdLoan "Request simulation"
            2: apiSdLoan -> micSdLoan "Initiate simulation"
            3: micSdLoan -> apiSysUtilCoreRetrieveParameterization "Retrieve parameters"
            4: micSdLoan -> apiSysIntCoreAdvancedRepayment "Request simulation"
            5: apiSysIntCoreAdvancedRepayment -> micSysIntCoreAdvancedRepayment "Register simulation"
            6: micSysIntCoreAdvancedRepayment -> transactSystem "Calculate simulation"
            7: transactSystem -> micSysIntCoreAdvancedRepayment "Return request data"
            8: transactSystem -> fncSysIntCoreReplicateAdvancedRepaymentStatus "Publish simulation status"
            9: fncSysIntCoreReplicateAdvancedRepaymentStatus -> sysAdvancedRepaymentStatusChangedV1 "Replicate simulation status"
            10: sysAdvancedRepaymentStatusChangedV1 -> micSysIntCoreAdvancedRepayment "Deliver simulation status"
            11: micSysIntCoreAdvancedRepayment -> apiSysIntCoreAdvancedRepayment "Provide request data"
            12: apiSysIntCoreAdvancedRepayment -> micSdLoan "Return request data"
            13: micSdLoan -> sdAdvancedRepaymentCreatedV1 "Publish simulation"
            14: micSdLoan -> apiSdLoan "Provide simulation"
            15: apiSdLoan -> channels "Return simulation"
            autoLayout lr 260 180
        }

        dynamic int010SimularPrepago "D_DEMO-RetrieveAdvancedRepayment" "D: DEMO - Retrieve Advanced Repayment Simulation. Audiencia: arquitectura y equipos de implementación. Propósito: consultar una simulación de prepago y su cronograma." {
            title "D: DEMO - Retrieve Advanced Repayment Simulation"
            1: channels -> apiSdLoan "Retrieve simulation"
            2: apiSdLoan -> micSdLoan "Retrieve simulation"
            3: micSdLoan -> apiSysIntCoreAdvancedRepayment "Request schedules"
            4: apiSysIntCoreAdvancedRepayment -> micSysIntCoreAdvancedRepayment "Retrieve schedules"
            5: micSysIntCoreAdvancedRepayment -> transactSystem "Retrieve schedules"
            6: transactSystem -> micSysIntCoreAdvancedRepayment "Return schedules"
            7: micSysIntCoreAdvancedRepayment -> apiSysIntCoreAdvancedRepayment "Provide schedules"
            8: apiSysIntCoreAdvancedRepayment -> micSdLoan "Return schedules"
            9: micSdLoan -> apiSdLoan "Provide simulation"
            10: apiSdLoan -> channels "Return simulation"
            autoLayout lr 260 180
        }

        // Flujos principales — descomposiciones técnicas en Transact.
        dynamic transactSystem "D_DEMO-TransactCreateAdvancedRepayment" "D: DEMO - Transact Create Advanced Repayment. Audiencia: arquitectura, Integración Temenos y Temenos. Propósito: descomponer la creación síncrona de una simulación en Transact." {
            title "D: DEMO - Transact Create Advanced Repayment"
            1: int010SimularPrepago -> apiTransact "Request simulation"
            2: apiTransact -> transactCore "Create simulation"
            3: transactCore -> apiTransact "Return request data"
            4: apiTransact -> int010SimularPrepago "Provide request data"
            autoLayout lr
        }

        dynamic transactSystem "D_DEMO-TransactRetrieveSchedules" "D: DEMO - Transact Retrieve Schedules. Audiencia: arquitectura, Integración Temenos y Temenos. Propósito: descomponer la consulta síncrona del cronograma completo en Transact." {
            title "D: DEMO - Transact Retrieve Schedules"
            1: int010SimularPrepago -> apiTransact "Request schedules"
            2: apiTransact -> transactCore "Retrieve schedules"
            3: transactCore -> apiTransact "Return schedules"
            4: apiTransact -> int010SimularPrepago "Provide schedules"
            autoLayout lr
        }

        // Flujos alternativos.
        dynamic int010SimularPrepago "D_DEMO-RetrieveAdvancedRepaymentSchedules" "D: DEMO - Retrieve Advanced Repayment Simulation Schedules. Audiencia: arquitectura y equipos de implementación. Propósito: consultar el cronograma completo tras la aceptación inicial." {
            title "D: DEMO - Retrieve Advanced Repayment Simulation Schedules"
            1: micSdLoan -> apiSysIntCoreAdvancedRepayment "Request schedules"
            2: apiSysIntCoreAdvancedRepayment -> micSysIntCoreAdvancedRepayment "Retrieve schedules"
            3: micSysIntCoreAdvancedRepayment -> transactSystem "Retrieve schedules"
            4: transactSystem -> micSysIntCoreAdvancedRepayment "Return schedules"
            5: micSysIntCoreAdvancedRepayment -> apiSysIntCoreAdvancedRepayment "Provide schedules"
            6: apiSysIntCoreAdvancedRepayment -> micSdLoan "Return schedules"
            autoLayout lr 260 180
        }

        // Flujos asíncronos.
        dynamic int010SimularPrepago "D_DEMO-ReplicateAdvancedRepaymentStatus" "D: DEMO - Replicate Advanced Repayment Simulation Status. Audiencia: arquitectura y equipos de implementación. Propósito: mostrar la réplica del estado de una simulación de prepago." {
            title "D: DEMO - Replicate Advanced Repayment Simulation Status"
            1: transactSystem -> fncSysIntCoreReplicateAdvancedRepaymentStatus "Publish status"
            2: fncSysIntCoreReplicateAdvancedRepaymentStatus -> sysAdvancedRepaymentStatusChangedV1 "Publish status"
            3: sysAdvancedRepaymentStatusChangedV1 -> micSysIntCoreAdvancedRepayment "Deliver status"
            autoLayout lr
        }

        dynamic transactSystem "D_DEMO-TransactPublishSimulationStatus" "D: DEMO - Transact Publish Simulation Status. Audiencia: arquitectura, Integración Temenos y Temenos. Propósito: mostrar la publicación de estados de ejecución desde Transact." {
            title "D: DEMO - Transact Publish Simulation Status"
            1: transactCore -> transactAdvancedRepaymentStatusChangedV1 "Publish status"
            2: int010SimularPrepago -> transactAdvancedRepaymentStatusChangedV1 "Consume status"
            autoLayout lr
        }

        // Flujos de error.
        dynamic int010SimularPrepago "D_DEMO-DeadLetterAdvancedRepayment" "D: DEMO - Register Failed Advanced Repayment Simulation. Audiencia: arquitectura y equipos de implementación. Propósito: registrar una simulación de prepago fallida." {
            title "D: DEMO - Register Failed Advanced Repayment Simulation"
            1: micSdLoan -> sdAdvancedRepaymentCreatedDeadLetterV1 "Publish failed request"
            autoLayout lr
        }

        // Flujos dinámicos L3.
        dynamic apiTransact "D_DEMO-TransactCaptureComponents" "D: DEMO - Capture Advanced Repayment Simulation. Audiencia: arquitectura, Integración Temenos y Temenos. Propósito: mostrar la colaboración interna para crear una simulación en Transact." {
            title "D: DEMO - Capture Advanced Repayment Simulation"
            1: int010SimularPrepago -> advancedRepaymentCaptureComponent "Request simulation"
            2: advancedRepaymentCaptureComponent -> transactCore "Create simulation"
            3: transactCore -> advancedRepaymentCaptureComponent "Return request data"
            4: advancedRepaymentCaptureComponent -> int010SimularPrepago "Provide request data"
            autoLayout lr
        }

        dynamic apiTransact "D_DEMO-TransactSchedulesComponents" "D: DEMO - Retrieve Loan Schedules. Audiencia: arquitectura, Integración Temenos y Temenos. Propósito: mostrar la colaboración interna para consultar el cronograma completo en Transact." {
            title "D: DEMO - Retrieve Loan Schedules"
            1: int010SimularPrepago -> schedulesApiComponent "Request schedules"
            2: schedulesApiComponent -> transactCore "Retrieve schedules"
            3: transactCore -> schedulesApiComponent "Return schedules"
            4: schedulesApiComponent -> int010SimularPrepago "Provide schedules"
            autoLayout lr
        }

        styles {
            element "Element" {
                width 600
                fontSize 14
            }
            element "Software System" {
                background #0A523D
                color #FFFFFF
            }
            element "Integration" {
                background #0A523D
                color #FFFFFF
            }
            element "External" {
                background #5F6C66
                color #FFFFFF
            }
            element "Legacy" {
                background #5F6C66
                color #FFFFFF
            }
            element "Container" {
                shape RoundedBox
                background #1D4CB8
                color #FFFFFF
            }
            element "Microservice" {
                shape Hexagon
                background #1D4CB8
                color #FFFFFF
                stroke #173D94
            }
            element "Component" {
                shape Component
                background #C7EBFF
                color #143B50
                stroke #2086C9
            }
            element "Store" {
                shape Cylinder
                background #1D4CB8
                color #FFFFFF
            }
            element "Function" {
                shape RoundedBox
                background #1D4CB8
                color #FFFFFF
                stroke #173D94
            }
            element "Future" {
                border dashed
                stroke #7A5AC8
                strokeWidth 4
            }
            relationship "Relationship" {
                color #667A74
                thickness 2
                routing Orthogonal
            }
            relationship "Async" {
                color #7A5AC8
            }
            relationship "Response" {
                color #9A9A9A
            }
            relationship "Error" {
                color #D32F2F
            }
        }
    }

}
